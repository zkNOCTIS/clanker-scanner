import { NextResponse } from "next/server";

// Proxy Noice API through our server to bypass CORS
// Browser can reach noice.so (no Vercel challenge) but CORS blocks the response
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://noice.so/api/public/projectByAddress?address=${address}`,
      {
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
      }
    );

    if (!res.ok) {
      return NextResponse.json({ error: `Noice API ${res.status}` }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch" }, { status: 502 });
  }
}
