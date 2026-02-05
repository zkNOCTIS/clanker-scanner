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

const STATEVIEW = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71";
const HOOK = "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC";
const WETH = "0x4200000000000000000000000000000000000006";
const CHAINLINK_ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const DYNAMIC_FEE = 0x800000;
const SUPPLY = 100_000_000_000n;

const STATEVIEW_ABI = [
  {
    inputs: [{ type: "bytes32", name: "poolId" }],
    name: "getSlot0",
    outputs: [
      { type: "uint160" },
      { type: "int24" },
      { type: "uint24" },
      { type: "uint24" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

const CHAINLINK_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { type: "uint80" },
      { type: "int256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("RPC timeout")), timeoutMs)
    ),
  ]);
}

// Calculate mcap for a single token using a specific provider (reuse provider for batch)
async function calculateMcapWithProvider(
  provider: ethers.JsonRpcProvider,
  tokenAddr: string,
  ethPriceUsd: number
): Promise<number> {
  const wethAddr = ethers.getAddress(WETH);
  const token = ethers.getAddress(tokenAddr);

  const [token0, token1] = [wethAddr, token].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1
  );

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ["address", "address", "uint24", "int24", "address"],
    [token0, token1, DYNAMIC_FEE, 200, ethers.getAddress(HOOK)]
  );
  const poolId = ethers.keccak256(encoded);

  const stateViewContract = new ethers.Contract(
    ethers.getAddress(STATEVIEW),
    STATEVIEW_ABI,
    provider
  );

  const poolData = await stateViewContract.getSlot0(poolId);
  const sqrtPriceX96 = BigInt(poolData[0]);

  if (sqrtPriceX96 === 0n) {
    throw new Error("Pool not initialized");
  }

  const Q96 = 2n ** 96n;
  const ONE_ETH = 10n ** 18n;

  let priceWei = ((Q96 * ONE_ETH) / sqrtPriceX96) * Q96 / sqrtPriceX96;

  let finalPriceWei: bigint;
  if (token0 === wethAddr) {
    finalPriceWei = priceWei;
  } else {
    finalPriceWei = priceWei > 0n ? (ONE_ETH * ONE_ETH) / priceWei : 0n;
  }

  const mcapInEth = (Number(finalPriceWei) * Number(SUPPLY)) / 10 ** 18;
  const mcapUsd = mcapInEth * ethPriceUsd;

  return Math.floor(mcapUsd);
}

// Try to get mcap for a token using fastest RPC
async function getMcapForToken(
  providers: ethers.JsonRpcProvider[],
  tokenAddr: string,
  ethPriceUsd: number
): Promise<number | null> {
  const results = await Promise.allSettled(
    providers.map((provider) =>
      withTimeout(calculateMcapWithProvider(provider, tokenAddr, ethPriceUsd), 5000)
    )
  );

  const successfulResult = results.find(
    (result): result is PromiseFulfilledResult<number> =>
      result.status === "fulfilled"
  );

  return successfulResult ? successfulResult.value : null;
}

async function handleBatch(addresses: string[]): Promise<Record<string, number | null>> {
  // Limit to 100 tokens max
  const limitedAddresses = addresses.slice(0, 100);

  // Create providers once for reuse
  const providers = RPC_URLS.map(
    (url) =>
      new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true })
  );

  // Get ETH price once (use first successful provider)
  let ethPriceUsd = 0;
  for (const provider of providers) {
    try {
      const chainlinkContract = new ethers.Contract(
        ethers.getAddress(CHAINLINK_ETH_USD),
        CHAINLINK_ABI,
        provider
      );
      const roundData = await withTimeout(chainlinkContract.latestRoundData(), 3000);
      ethPriceUsd = Number(roundData[1]) / 10 ** 8;
      break;
    } catch {
      continue;
    }
  }

  if (ethPriceUsd === 0) {
    console.error("Failed to get ETH price from all providers");
    return Object.fromEntries(limitedAddresses.map((addr) => [addr.toLowerCase(), null]));
  }

  console.log(`[Batch] ETH price: $${ethPriceUsd}, fetching ${limitedAddresses.length} tokens`);

  // Fetch all mcaps in parallel
  const results = await Promise.all(
    limitedAddresses.map(async (addr) => {
      const mcap = await getMcapForToken(providers, addr, ethPriceUsd);
      return [addr.toLowerCase(), mcap] as const;
    })
  );

  const mcaps = Object.fromEntries(results);
  const successCount = Object.values(mcaps).filter((v) => v !== null).length;
  console.log(`[Batch] Completed: ${successCount}/${limitedAddresses.length} successful`);

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
