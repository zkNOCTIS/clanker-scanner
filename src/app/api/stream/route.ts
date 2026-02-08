import { Redis } from "@upstash/redis";

export const runtime = "edge";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const REDIS_KEY = "clanker:tokens:list";
const POLL_INTERVAL_MS = 50;
const MAX_STREAM_DURATION_MS = 25000;

export async function GET(req: Request) {
  const lastEventId = req.headers.get("Last-Event-ID");
  const knownAddresses = lastEventId ? new Set(lastEventId.split(",")) : new Set<string>();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const startTime = Date.now();
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

      // Poll loop
      while (Date.now() - startTime < MAX_STREAM_DURATION_MS) {
        try {
          const rawPoll = (await redis.lrange(REDIS_KEY, 0, 49)) || [];
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

          // Heartbeat to keep connection alive
          controller.enqueue(encoder.encode(`:heartbeat\n\n`));
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
