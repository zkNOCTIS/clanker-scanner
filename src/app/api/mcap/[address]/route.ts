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

// Function to calculate mcap using a specific RPC
async function calculateMcapWithRpc(rpcUrl: string, tokenAddr: string): Promise<number> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const wethAddr = ethers.getAddress(WETH);
  const token = ethers.getAddress(tokenAddr);

  // Sort addresses for pool ID calculation
  const [token0, token1] = [wethAddr, token].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1
  );

  // Calculate pool ID using Uniswap V4 format
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [token0, token1, DYNAMIC_FEE, 200, ethers.getAddress(HOOK)]
  );
  const poolId = ethers.keccak256(encoded);

  // Get pool data from StateView
  const stateViewContract = new ethers.Contract(
    ethers.getAddress(STATEVIEW),
    STATEVIEW_ABI,
    provider
  );

  const poolData = await stateViewContract.getSlot0(poolId);
  const sqrtPriceX96 = BigInt(poolData[0]);

  if (sqrtPriceX96 === 0n) {
    throw new Error('Pool not initialized');
  }

  // Calculate price from sqrtPriceX96
  const Q96 = 2n ** 96n;
  const ONE_ETH = 10n ** 18n;

  let priceWei = ((Q96 * ONE_ETH) / sqrtPriceX96) * Q96 / sqrtPriceX96;

  // If WETH is token1, invert the price
  let finalPriceWei: bigint;
  if (token0 === wethAddr) {
    finalPriceWei = priceWei;
  } else {
    finalPriceWei = priceWei > 0n ? (ONE_ETH * ONE_ETH) / priceWei : 0n;
  }

  // Calculate market cap in ETH
  const mcapInEth = (finalPriceWei * SUPPLY) / ONE_ETH;

  // Get ETH/USD price from Chainlink
  const chainlinkContract = new ethers.Contract(
    ethers.getAddress(CHAINLINK_ETH_USD),
    CHAINLINK_ABI,
    provider
  );

  const roundData = await chainlinkContract.latestRoundData();
  const ethPriceUsd = Number(roundData[1]) / 10 ** 8;

  // Calculate final market cap in USD
  const mcapUsd = Number(mcapInEth) / 10 ** 18 * ethPriceUsd;

  return Math.floor(mcapUsd);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;

  try {
    // Try all RPC endpoints in parallel - use first successful result
    const results = await Promise.allSettled(
      RPC_URLS.map(rpcUrl => calculateMcapWithRpc(rpcUrl, address))
    );

    // Find first successful result
    const successfulResult = results.find(
      (result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled'
    );

    if (successfulResult) {
      return NextResponse.json({
        mcap: successfulResult.value,
      }, {
        headers: {
          'Cache-Control': 'public, s-maxage=3, stale-while-revalidate=6'
        }
      });
    }

    // All RPCs failed
    console.error('All RPC endpoints failed');
    return NextResponse.json({ mcap: null });

  } catch (error) {
    console.error('Error calculating market cap:', error);
    return NextResponse.json({ mcap: null });
  }
}
