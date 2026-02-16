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
// WETH-paired pools (tickSpacing=200)
const WETH_POOL_CONFIGS = [
  { hook: "0x3e342a06f9592459D75721d6956B570F02eF2Dc0", fee: 12000 },      // Bankr v1 (old, fixed fee)
  { hook: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0", fee: 8388608 },   // Bankr v2 (new, dynamic fee)
  { hook: "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC", fee: 8388608 },   // Clanker AI (X/Twitter)
  { hook: "0xd60D6B218116cFd801E28F78d011a203D2b068Cc", fee: 8388608 },   // Clanker (Farcaster)
];
// USDC-paired pools (tickSpacing=60) — Noice/Doppler
const USDC_POOL_CONFIGS = [
  { hook: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0", fee: 8388608, tickSpacing: 60 },   // Noice (Bankr v2 hook)
];
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAINLINK_ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
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

function computeWethPoolIds(tokenAddr: string): string[] {
  const wethAddr = ethers.getAddress(WETH);
  const token = ethers.getAddress(tokenAddr);

  const [token0, token1] = [wethAddr, token].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1
  );

  return WETH_POOL_CONFIGS.map(({ hook, fee }) => {
    const encoded = abiCoder.encode(
      ["address", "address", "uint24", "int24", "address"],
      [token0, token1, fee, 200, ethers.getAddress(hook)]
    );
    return ethers.keccak256(encoded);
  });
}

function computeUsdcPoolIds(tokenAddr: string): string[] {
  const usdcAddr = ethers.getAddress(USDC);
  const token = ethers.getAddress(tokenAddr);

  const [token0, token1] = [usdcAddr, token].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1
  );

  return USDC_POOL_CONFIGS.map(({ hook, fee, tickSpacing }) => {
    const encoded = abiCoder.encode(
      ["address", "address", "uint24", "int24", "address"],
      [token0, token1, fee, tickSpacing, ethers.getAddress(hook)]
    );
    return ethers.keccak256(encoded);
  });
}

function sqrtPriceToMcapWeth(
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

// USDC pool: token(18 decimals) paired with USDC(6 decimals) — price is directly in USD
function sqrtPriceToMcapUsdc(
  sqrtPriceX96: bigint,
  tokenAddr: string
): number | null {
  if (sqrtPriceX96 === 0n) return null;

  const usdcAddr = ethers.getAddress(USDC);
  const token = ethers.getAddress(tokenAddr);
  const [token0] = [usdcAddr, token].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1
  );

  // sqrtPriceX96 = sqrt(token1/token0) * 2^96
  // price = (sqrtPriceX96 / 2^96)^2 = token1_per_token0
  // We need: USDC per token (token has 18 dec, USDC has 6 dec)
  const Q96 = 2n ** 96n;

  // price_raw = sqrtPriceX96^2 / 2^192 = token1 per token0 (in their native decimals)
  // To get USDC per 1 full token (1e18 smallest units):
  // If token0 = USDC: price_raw = token_per_USDC → invert to get USDC_per_token
  //   USDC_per_token = (1 / price_raw) * 10^(18-6) = 10^12 / price_raw
  // If token0 = token: price_raw = USDC_per_token (adjusted for decimals)
  //   USDC_per_token = price_raw / 10^(18-6) = price_raw / 10^12

  // Use high precision: scale numerator by 10^30
  const SCALE = 10n ** 30n;

  if (token0 === usdcAddr) {
    // sqrtPrice = sqrt(token_per_USDC) * 2^96
    // token_per_USDC = sqrtPrice^2 / 2^192 (this is in 18dec_token per 6dec_USDC)
    // USDC_per_token = 1 / token_per_USDC * 10^(18-6) = 2^192 * 10^12 / sqrtPrice^2
    const numerator = Q96 * Q96 * (10n ** 12n) * SCALE;
    const denominator = sqrtPriceX96 * sqrtPriceX96;
    const priceScaled = numerator / denominator; // scaled by SCALE
    const mcapUsd = (Number(priceScaled) * Number(SUPPLY)) / Number(SCALE);
    return Math.floor(mcapUsd);
  } else {
    // token0 = token, token1 = USDC
    // sqrtPrice = sqrt(USDC_per_token) * 2^96 (USDC in 6dec per token in 18dec)
    // USDC_per_1_token = sqrtPrice^2 / 2^192 * 10^(18-6)
    //                  = sqrtPrice^2 * 10^12 / 2^192
    const numerator = sqrtPriceX96 * sqrtPriceX96 * (10n ** 12n) * SCALE;
    const denominator = Q96 * Q96;
    const priceScaled = numerator / denominator;
    const mcapUsd = (Number(priceScaled) * Number(SUPPLY)) / Number(SCALE);
    return Math.floor(mcapUsd);
  }
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

  // Calls 1..N: getSlot0 for each token × each WETH pool config
  const wethConfigCount = WETH_POOL_CONFIGS.length;
  const usdcConfigCount = USDC_POOL_CONFIGS.length;
  const totalPerToken = wethConfigCount + usdcConfigCount;
  for (const addr of addresses) {
    const wethPoolIds = computeWethPoolIds(addr);
    for (const poolId of wethPoolIds) {
      calls.push({
        target: ethers.getAddress(STATEVIEW),
        allowFailure: true,
        callData: stateviewIface.encodeFunctionData("getSlot0", [poolId]),
      });
    }
    const usdcPoolIds = computeUsdcPoolIds(addr);
    for (const poolId of usdcPoolIds) {
      calls.push({
        target: ethers.getAddress(STATEVIEW),
        allowFailure: true,
        callData: stateviewIface.encodeFunctionData("getSlot0", [poolId]),
      });
    }
  }

  const results = await multicall.aggregate3(calls);

  // Parse ETH price (call 0)
  const ethPriceData = chainlinkIface.decodeFunctionResult(
    "latestRoundData",
    results[0].returnData
  );
  const ethPrice = Number(ethPriceData[1]) / 10 ** 8;

  // Parse each token's slot0 — try WETH pools first, then USDC pools
  const mcaps: Record<string, number | null> = {};
  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i].toLowerCase();
    let found = false;
    const baseIdx = 1 + i * totalPerToken;

    // Try WETH pools first
    for (let h = 0; h < wethConfigCount; h++) {
      const result = results[baseIdx + h];
      if (!result.success) continue;

      try {
        const decoded = stateviewIface.decodeFunctionResult(
          "getSlot0",
          result.returnData
        );
        const sqrtPriceX96 = BigInt(decoded[0]);
        if (sqrtPriceX96 === 0n) continue;
        mcaps[addr] = sqrtPriceToMcapWeth(sqrtPriceX96, addresses[i], ethPrice);
        found = true;
        break;
      } catch {
        continue;
      }
    }

    // If no WETH pool found, try USDC pools
    if (!found) {
      for (let h = 0; h < usdcConfigCount; h++) {
        const result = results[baseIdx + wethConfigCount + h];
        if (!result.success) continue;

        try {
          const decoded = stateviewIface.decodeFunctionResult(
            "getSlot0",
            result.returnData
          );
          const sqrtPriceX96 = BigInt(decoded[0]);
          if (sqrtPriceX96 === 0n) continue;
          mcaps[addr] = sqrtPriceToMcapUsdc(sqrtPriceX96, addresses[i]);
          found = true;
          break;
        } catch {
          continue;
        }
      }
    }

    if (!found) mcaps[addr] = null;
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
