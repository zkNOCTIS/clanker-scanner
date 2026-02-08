import { NextResponse } from "next/server";
import { ethers } from "ethers";

// Multiple RPC endpoints - race them all for fastest response
const RPC_URLS = [
  "http://88.198.55.177:8545",
  "http://5.9.117.135:8545",
  "http://157.90.128.109:8545",
  "http://144.76.118.243:8545",
  "http://176.9.122.100:8545",
  "http://144.76.111.79:8545",
  "http://148.251.138.249:8545",
];

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const STATEVIEW = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71";
const HOOK = "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC";
const WETH = "0x4200000000000000000000000000000000000006";
const CHAINLINK_ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const DYNAMIC_FEE = 0x800000;
const SUPPLY = 100_000_000_000n;

const MULTICALL3_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
        name: "calls",
        type: "tuple[]",
      },
    ],
    name: "aggregate3",
    outputs: [
      {
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
];

const stateviewIface = new ethers.Interface([
  "function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)",
]);

const chainlinkIface = new ethers.Interface([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("RPC timeout")), timeoutMs)
    ),
  ]);
}

function computePoolId(tokenAddr: string): string {
  const wethAddr = ethers.getAddress(WETH);
  const token = ethers.getAddress(tokenAddr);

  const [token0, token1] = [wethAddr, token].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1
  );

  const encoded = abiCoder.encode(
    ["address", "address", "uint24", "int24", "address"],
    [token0, token1, DYNAMIC_FEE, 200, ethers.getAddress(HOOK)]
  );
  return ethers.keccak256(encoded);
}

function sqrtPriceToMcap(
  sqrtPriceX96: bigint,
  tokenAddr: string,
  ethPriceUsd: number
): number | null {
  if (sqrtPriceX96 === 0n) return null;

  const wethAddr = ethers.getAddress(WETH);
  const token = ethers.getAddress(tokenAddr);
  const [token0] = [wethAddr, token].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1
  );

  const Q96 = 2n ** 96n;
  const ONE_ETH = 10n ** 18n;

  const priceWei = ((Q96 * ONE_ETH) / sqrtPriceX96) * Q96 / sqrtPriceX96;

  let finalPriceWei: bigint;
  if (token0 === wethAddr) {
    finalPriceWei = priceWei;
  } else {
    finalPriceWei = priceWei > 0n ? (ONE_ETH * ONE_ETH) / priceWei : 0n;
  }

  const mcapInEth = (Number(finalPriceWei) * Number(SUPPLY)) / 10 ** 18;
  return Math.floor(mcapInEth * ethPriceUsd);
}

// Single multicall: ETH price + all getSlot0 calls in one RPC request
async function multicallBatch(
  provider: ethers.JsonRpcProvider,
  addresses: string[]
): Promise<{ ethPrice: number; mcaps: Record<string, number | null> }> {
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);

  // Build calls array: [chainlink, slot0_0, slot0_1, ..., slot0_n]
  const calls: { target: string; allowFailure: boolean; callData: string }[] = [];

  // Call 0: Chainlink ETH/USD price
  calls.push({
    target: ethers.getAddress(CHAINLINK_ETH_USD),
    allowFailure: false,
    callData: chainlinkIface.encodeFunctionData("latestRoundData"),
  });

  // Calls 1..N: getSlot0 for each token
  const poolIds = addresses.map((addr) => computePoolId(addr));
  for (const poolId of poolIds) {
    calls.push({
      target: ethers.getAddress(STATEVIEW),
      allowFailure: true,
      callData: stateviewIface.encodeFunctionData("getSlot0", [poolId]),
    });
  }

  const results = await multicall.aggregate3(calls);

  // Parse ETH price (call 0)
  const ethPriceData = chainlinkIface.decodeFunctionResult(
    "latestRoundData",
    results[0].returnData
  );
  const ethPrice = Number(ethPriceData[1]) / 10 ** 8;

  // Parse each token's slot0 (calls 1..N)
  const mcaps: Record<string, number | null> = {};
  for (let i = 0; i < addresses.length; i++) {
    const result = results[i + 1]; // offset by 1 for chainlink call
    const addr = addresses[i].toLowerCase();

    if (!result.success) {
      mcaps[addr] = null;
      continue;
    }

    try {
      const decoded = stateviewIface.decodeFunctionResult(
        "getSlot0",
        result.returnData
      );
      const sqrtPriceX96 = BigInt(decoded[0]);
      mcaps[addr] = sqrtPriceToMcap(sqrtPriceX96, addresses[i], ethPrice);
    } catch {
      mcaps[addr] = null;
    }
  }

  return { ethPrice, mcaps };
}

async function handleBatch(
  addresses: string[]
): Promise<Record<string, number | null>> {
  const limitedAddresses = addresses.slice(0, 100);

  const providers = RPC_URLS.map(
    (url) =>
      new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true })
  );

  // Race all providers — first successful multicall wins
  const results = await Promise.allSettled(
    providers.map((provider) =>
      withTimeout(multicallBatch(provider, limitedAddresses), 5000)
    )
  );

  const winner = results.find(
    (r): r is PromiseFulfilledResult<{ ethPrice: number; mcaps: Record<string, number | null> }> =>
      r.status === "fulfilled"
  );

  if (!winner) {
    console.error("[Batch] All providers failed");
    return Object.fromEntries(
      limitedAddresses.map((addr) => [addr.toLowerCase(), null])
    );
  }

  const { ethPrice, mcaps } = winner.value;
  const successCount = Object.values(mcaps).filter((v) => v !== null).length;
  console.log(
    `[Batch] ETH $${ethPrice.toFixed(0)} | ${successCount}/${limitedAddresses.length} mcaps | 1 multicall`
  );

  return mcaps;
}

// GET /api/mcap/batch?addresses=0x123,0x456,0x789
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const addressesParam = searchParams.get("addresses");

  if (!addressesParam) {
    return NextResponse.json(
      { error: "Missing addresses parameter" },
      { status: 400 }
    );
  }

  const addresses = addressesParam.split(",").filter(Boolean);

  if (addresses.length === 0) {
    return NextResponse.json({ error: "No valid addresses" }, { status: 400 });
  }

  const mcaps = await handleBatch(addresses);
  return NextResponse.json({ mcaps });
}

// POST /api/mcap/batch with body { addresses: ["0x123", "0x456"] }
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const addresses: string[] = body.addresses;

    if (!Array.isArray(addresses) || addresses.length === 0) {
      return NextResponse.json(
        { error: "Invalid addresses array" },
        { status: 400 }
      );
    }

    const mcaps = await handleBatch(addresses);
    return NextResponse.json({ mcaps });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
}
