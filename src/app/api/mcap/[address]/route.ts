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
const WETH_POOL_CONFIGS = [
  { hook: "0x3e342a06f9592459D75721d6956B570F02eF2Dc0", fee: 12000, tickSpacing: 200 },      // Bankr v1
  { hook: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0", fee: 8388608, tickSpacing: 200 },   // Bankr v2
  { hook: "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC", fee: 8388608, tickSpacing: 200 },   // Clanker AI (X/Twitter)
  { hook: "0xd60D6B218116cFd801E28F78d011a203D2b068Cc", fee: 8388608, tickSpacing: 200 },   // Clanker (Farcaster)
];
const USDC_POOL_CONFIGS = [
  { hook: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0", fee: 8388608, tickSpacing: 60 },   // Noice (Bankr v2 hook)
];
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAINLINK_ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const SUPPLY = 100_000_000_000n;

// Minimal ABI for StateView getSlot0
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

// Minimal ABI for Chainlink price feed
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

// Timeout helper
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('RPC timeout')), timeoutMs)
    )
  ]);
}

// Function to calculate mcap using a specific RPC
async function calculateMcapWithRpc(rpcUrl: string, tokenAddr: string): Promise<number> {
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
    staticNetwork: true,
  });

  const wethAddr = ethers.getAddress(WETH);
  const usdcAddr = ethers.getAddress(USDC);
  const token = ethers.getAddress(tokenAddr);
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const stateViewContract = new ethers.Contract(
    ethers.getAddress(STATEVIEW),
    STATEVIEW_ABI,
    provider
  );

  // Try WETH pools first (most tokens)
  const [wethToken0, wethToken1] = [wethAddr, token].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1
  );

  let sqrtPriceX96 = 0n;
  let isUsdcPool = false;

  for (const { hook, fee, tickSpacing } of WETH_POOL_CONFIGS) {
    const encoded = abiCoder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [wethToken0, wethToken1, fee, tickSpacing, ethers.getAddress(hook)]
    );
    const poolId = ethers.keccak256(encoded);
    const poolData = await stateViewContract.getSlot0(poolId);
    sqrtPriceX96 = BigInt(poolData[0]);
    if (sqrtPriceX96 !== 0n) break;
  }

  // If no WETH pool, try USDC pools (Noice/Doppler)
  if (sqrtPriceX96 === 0n) {
    const [usdcToken0, usdcToken1] = [usdcAddr, token].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1
    );

    for (const { hook, fee, tickSpacing } of USDC_POOL_CONFIGS) {
      const encoded = abiCoder.encode(
        ['address', 'address', 'uint24', 'int24', 'address'],
        [usdcToken0, usdcToken1, fee, tickSpacing, ethers.getAddress(hook)]
      );
      const poolId = ethers.keccak256(encoded);
      const poolData = await stateViewContract.getSlot0(poolId);
      sqrtPriceX96 = BigInt(poolData[0]);
      if (sqrtPriceX96 !== 0n) {
        isUsdcPool = true;
        break;
      }
    }
  }

  if (sqrtPriceX96 === 0n) {
    throw new Error('Pool not initialized');
  }

  const Q96 = 2n ** 96n;

  if (isUsdcPool) {
    // USDC pool: token(18dec) paired with USDC(6dec) — price directly in USD
    const [token0] = [usdcAddr, token].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1
    );

    const SCALE = 10n ** 30n;
    let mcapUsd: number;

    if (token0 === usdcAddr) {
      // sqrtPrice = sqrt(token_per_USDC) → invert for USDC per token
      const numerator = Q96 * Q96 * (10n ** 12n) * SCALE;
      const denominator = sqrtPriceX96 * sqrtPriceX96;
      const priceScaled = numerator / denominator;
      mcapUsd = (Number(priceScaled) * Number(SUPPLY)) / Number(SCALE);
    } else {
      // sqrtPrice = sqrt(USDC_per_token)
      const numerator = sqrtPriceX96 * sqrtPriceX96 * (10n ** 12n) * SCALE;
      const denominator = Q96 * Q96;
      const priceScaled = numerator / denominator;
      mcapUsd = (Number(priceScaled) * Number(SUPPLY)) / Number(SCALE);
    }

    console.log(`[${tokenAddr}] USDC pool mcap: $${Math.floor(mcapUsd).toLocaleString()}`);
    return Math.floor(mcapUsd);
  }

  // WETH pool path
  const ONE_ETH = 10n ** 18n;
  const priceWei = ((Q96 * ONE_ETH) / sqrtPriceX96) * Q96 / sqrtPriceX96;

  let finalPriceWei: bigint;
  if (wethToken0 === wethAddr) {
    finalPriceWei = priceWei;
  } else {
    finalPriceWei = priceWei > 0n ? (ONE_ETH * ONE_ETH) / priceWei : 0n;
  }

  const chainlinkContract = new ethers.Contract(
    ethers.getAddress(CHAINLINK_ETH_USD),
    CHAINLINK_ABI,
    provider
  );
  const roundData = await chainlinkContract.latestRoundData();
  const ethPriceUsd = Number(roundData[1]) / 10 ** 8;

  const mcapInEth = (Number(finalPriceWei) * Number(SUPPLY)) / 10 ** 18;
  const mcapUsd = mcapInEth * ethPriceUsd;
  console.log(`[${tokenAddr}] WETH pool mcap: $${Math.floor(mcapUsd).toLocaleString()}`);
  return Math.floor(mcapUsd);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;

  try {
    // Try all RPC endpoints in parallel with 5s timeout - use first successful result
    const results = await Promise.allSettled(
      RPC_URLS.map(rpcUrl => withTimeout(calculateMcapWithRpc(rpcUrl, address), 5000))
    );

    // Log results for debugging
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failCount = results.filter(r => r.status === 'rejected').length;
    console.log(`Mcap calculation for ${address}: ${successCount} succeeded, ${failCount} failed`);

    // Find first successful result
    const successfulResult = results.find(
      (result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled'
    );

    if (successfulResult) {
      console.log(`Returning mcap: $${successfulResult.value.toLocaleString()}`);
      return NextResponse.json({
        mcap: successfulResult.value,
      });
    }

    // All RPCs failed - log some error details
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => r.reason?.message || r.reason)
      .slice(0, 3); // First 3 errors
    console.error(`All RPC endpoints failed for ${address}. Sample errors:`, errors);
    return NextResponse.json({ mcap: null });

  } catch (error) {
    console.error('Error calculating market cap:', error);
    return NextResponse.json({ mcap: null });
  }
}
