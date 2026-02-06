import { NextResponse } from "next/server";
import { ethers } from "ethers";

const RPC_URLS = [
  "http://88.198.55.177:8545",
  "http://5.9.117.135:8545",
  "http://157.90.128.109:8545",
  "http://144.76.118.243:8545",
  "http://176.9.122.100:8545",
  "http://144.76.111.79:8545",
  "http://148.251.138.249:8545",
];

// Cache block timestamps to avoid re-fetching
const cache = new Map<string, number>();

async function getBlockTimestamp(txHash: string): Promise<number | null> {
  if (cache.has(txHash)) return cache.get(txHash)!;

  const providers = RPC_URLS.map((url) => new ethers.JsonRpcProvider(url));

  try {
    const receipt = await Promise.any(
      providers.map((p) => p.getTransactionReceipt(txHash))
    );
    if (!receipt || !receipt.blockNumber) return null;

    const block = await Promise.any(
      providers.map((p) => p.getBlock(receipt.blockNumber))
    );
    if (!block) return null;

    const timestamp = block.timestamp * 1000; // Convert to ms
    cache.set(txHash, timestamp);

    // Keep cache from growing unbounded
    if (cache.size > 500) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }

    return timestamp;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const txHash = searchParams.get("tx");

  if (!txHash) {
    return NextResponse.json({ error: "Missing tx param" }, { status: 400 });
  }

  const timestamp = await getBlockTimestamp(txHash);

  if (timestamp === null) {
    return NextResponse.json({ error: "Could not fetch" }, { status: 404 });
  }

  return NextResponse.json({ timestamp });
}
