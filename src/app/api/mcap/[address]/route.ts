import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;

  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { cache: "no-store" }
    );

    if (!res.ok) {
      return NextResponse.json({ mcap: null });
    }

    const data = await res.json();
    const pair = data.pairs?.[0];

    if (!pair) {
      return NextResponse.json({ mcap: null });
    }

    return NextResponse.json({
      mcap: pair.marketCap || pair.fdv || null,
      priceUsd: pair.priceUsd || null,
      priceChange24h: pair.priceChange?.h24 || null,
    });
  } catch (e) {
    return NextResponse.json({ mcap: null });
  }
}
