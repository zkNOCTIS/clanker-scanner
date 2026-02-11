import { NextResponse } from "next/server";

// All RPCs including sequencer + private nodes — server-side only (no CORS issues)
const BROADCAST_RPCS = [
  "https://mainnet-sequencer.base.org",   // Direct sequencer — fastest
  "http://88.198.55.177:8545",            // Private Hetzner nodes
  "http://5.9.117.135:8545",
  "http://157.90.128.109:8545",
  "http://144.76.118.243:8545",
  "http://176.9.122.100:8545",
  "http://144.76.111.79:8545",
  "http://148.251.138.249:8545",
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];

async function sendRaw(signedTx: string, rpcUrl: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [signedTx],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

export async function POST(request: Request) {
  try {
    const { signedTx } = await request.json();
    if (!signedTx || typeof signedTx !== "string") {
      return NextResponse.json({ error: "Missing signedTx" }, { status: 400 });
    }

    // Race all RPCs — first success wins
    const hash = await Promise.any(
      BROADCAST_RPCS.map((url) => sendRaw(signedTx, url))
    );

    return NextResponse.json({ hash });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "All RPCs failed" },
      { status: 502 }
    );
  }
}
