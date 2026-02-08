import { Redis } from "@upstash/redis";

export const runtime = "edge";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const REDIS_KEY = "clanker:tokens:list";
const POLL_INTERVAL_MS = 50;
const MAX_STREAM_DURATION_MS = 55000; // 55s (Vercel edge max ~60s)
const HEARTBEAT_INTERVAL_MS = 10000; // heartbeat every 10s, not every poll

export async function GET(req: Request) {
  const lastEventId = req.headers.get("Last-Event-ID");
  const knownAddresses = lastEventId ? new Set(lastEventId.split(",")) : new Set<string>();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const startTime = Date.now();
      let lastHeartbeat = Date.now();
      const lastSeenAddresses = new Set(knownAddresses);

      // Send initial batch on first connect
      if (knownAddresses.size === 0) {
        try {
          const raw = (await redis.lrange(REDIS_KEY, 0, 49)) || [];
          const batch = raw as any[];
          if (batch.length > 0) {
            batch.forEach((t: any) => lastSeenAddresses.add(t.contract_address));
            controller.enqueue(
              encoder.encode(`event:init\ndata:${JSON.stringify(batch)}\n\n`)
            );
          }
        } catch {
          controller.enqueue(
            encoder.encode(`event:error\ndata:{"message":"Redis fetch failed"}\n\n`)
          );
        }
      }

      // Poll loop - only check head of list for new tokens
      while (Date.now() - startTime < MAX_STREAM_DURATION_MS) {
        try {
          // Only read first 5 items - new tokens are always at the head
          const rawPoll = (await redis.lrange(REDIS_KEY, 0, 4)) || [];
          const tokens = rawPoll as any[];
          const newTokens = tokens.filter(
            (t: any) => !lastSeenAddresses.has(t.contract_address)
          );

          if (newTokens.length > 0) {
            for (const token of newTokens) {
              lastSeenAddresses.add(token.contract_address);
              controller.enqueue(
                encoder.encode(`event:token\ndata:${JSON.stringify(token)}\n\n`)
              );
            }
          }

          // Heartbeat only every 10s to keep alive without flooding
          if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
            controller.enqueue(encoder.encode(`:heartbeat\n\n`));
            lastHeartbeat = Date.now();
          }
        } catch {
          // Transient Redis error - continue polling
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      // Close after max duration - EventSource will auto-reconnect
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
