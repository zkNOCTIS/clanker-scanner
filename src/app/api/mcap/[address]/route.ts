import { NextResponse } from "next/server";
import { ethers } from "ethers";

// Configuration
const RPC_URL = "http://88.198.55.177:8545";
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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // Checksum addresses
    const tokenAddr = ethers.getAddress(address);
    const wethAddr = ethers.getAddress(WETH);

    // Sort addresses for pool ID calculation
    const [token0, token1] = [wethAddr, tokenAddr].sort((a, b) =>
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
      return NextResponse.json({ mcap: null });
    }

    // Calculate price from sqrtPriceX96
    const Q96 = 2n ** 96n;
    const ONE_ETH = 10n ** 18n;

    // price = (Q96 / sqrtPriceX96)^2 * 10^18
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

    return NextResponse.json({
      mcap: Math.floor(mcapUsd),
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60'
      }
    });

  } catch (error) {
    console.error('Error calculating market cap:', error);
    return NextResponse.json({ mcap: null });
  }
}
