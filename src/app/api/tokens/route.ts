import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch(
      "https://www.clanker.world/api/tokens?sort=desc&page=0&limit=10",
      {
        headers: {
          "User-Agent": "ClankerScanner/1.0",
          "Accept": "application/json",
        },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      console.error("Clanker API error:", res.status, res.statusText);
      return NextResponse.json(
        { error: `Clanker API returned ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    // Log first token to see structure
    if (data.data?.[0]) {
      console.log("Sample token data:", JSON.stringify(data.data[0], null, 2));
    }
    return NextResponse.json(data);
  } catch (e) {
    console.error("Fetch error:", e);
    return NextResponse.json(
      { error: String(e) },
      { status: 500 }
    );
  }
}
