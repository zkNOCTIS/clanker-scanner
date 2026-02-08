"use client";

import { Suspense, useEffect, useState, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { ClankerToken, hasRealSocialContext, getTweetUrl, getTweetId, detectFeeRecommendation } from "@/types";
import { TokenCard } from "@/components/TokenCard";

export default function Home() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const [tokens, setTokens] = useState<ClankerToken[]>([]);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mcaps, setMcaps] = useState<Record<string, number>>({});
  const seenRef = useRef<Set<string>>(new Set());
  const deletedRef = useRef<Set<string>>(new Set());
  const initialLoadDoneRef = useRef(false);
  const newTokensRef = useRef<Set<string>>(new Set()); // Track tokens that arrived after initial load
  const [, setTick] = useState(0);
  const [searchCA, setSearchCA] = useState("");
  const searchParams = useSearchParams();
  const botDomain = searchParams.get("bot") || "based_vip_eu_bot";

  // Remove token when tweet is detected as deleted
  const handleTweetDeleted = (contractAddress: string) => {
    deletedRef.current.add(contractAddress);
    setTokens((prev) => prev.filter((t) => t.contract_address !== contractAddress));
  };

  // Search for token by contract address
  const handleSearch = () => {
    if (!searchCA.trim()) return;
    const normalized = searchCA.toLowerCase().trim();
    const found = tokens.find(t => t.contract_address.toLowerCase() === normalized);
    if (found) {
      document.getElementById(`token-${found.contract_address}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  // Update timestamp display in Recent sidebar every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 10000);
    return () => clearInterval(interval);
  }, []);

  // Stable dependency: only re-run mcap effect when the actual list of addresses changes
  // (not when recommendation flags update via setTokens)
  const tokenAddresses = tokens.map(t => t.contract_address).join(",");

  // Fetch and update mcaps for sidebar - runs every 3 seconds using batch endpoint
  useEffect(() => {
    if (!tokenAddresses) return;

    const abortController = new AbortController();
    let inFlight = false;

    const fetchAllMcaps = async () => {
      if (inFlight) return; // Skip if previous fetch still pending - prevents connection pool exhaustion
      inFlight = true;

      try {
        const res = await fetch(`/api/mcap/batch?addresses=${tokenAddresses}`, {
          signal: abortController.signal,
        });
        const data = await res.json();
        if (data.mcaps) {
          setMcaps((prev) => {
            const updated = { ...prev };
            for (const [addr, mcap] of Object.entries(data.mcaps)) {
              if (mcap !== null) {
                updated[addr] = mcap as number;
              }
            }
            return updated;
          });
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        console.error("[Scanner] Batch mcap fetch error:", e);
      } finally {
        inFlight = false;
      }
    };

    // Fetch immediately when token list changes
    fetchAllMcaps();

    // Then fetch every 3 seconds to update mcaps
    const interval = setInterval(fetchAllMcaps, 3000);
    return () => {
      clearInterval(interval);
      abortController.abort();
    };
  }, [tokenAddresses]);

  // WebSocket connection to Railway listener for real-time token push
  useEffect(() => {
    if (!scanning) return;

    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const processTokens = (incoming: ClankerToken[]) => {
      const unseen = incoming.filter(
        (t) => !seenRef.current.has(t.contract_address) && !deletedRef.current.has(t.contract_address) && hasRealSocialContext(t)
      );

      if (unseen.length > 0) {
        unseen.forEach((t) => {
          seenRef.current.add(t.contract_address);
          if (initialLoadDoneRef.current) {
            newTokensRef.current.add(t.contract_address);
          }
        });
        setTokens((prev) => {
          const merged = [...unseen, ...prev];
          const seen = new Set<string>();
          return merged.filter((t) => {
            if (seen.has(t.contract_address)) return false;
            seen.add(t.contract_address);
            return true;
          }).slice(0, 50);
        });
      }

      if (!initialLoadDoneRef.current) {
        initialLoadDoneRef.current = true;
      }
    };

    const connect = () => {
      if (destroyed) return;
      let wsUrl = process.env.NEXT_PUBLIC_WS_URL;
      if (!wsUrl) { setError("WS URL not configured"); return; }
      if (!wsUrl.startsWith("ws://") && !wsUrl.startsWith("wss://")) {
        wsUrl = `wss://${wsUrl}`;
      }

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log("[WS] Connected");
        setError(null);
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "init") {
          console.log(`[WS] Init: ${msg.tokens.length} tokens`);
          processTokens(msg.tokens);
        } else if (msg.type === "token") {
          console.log(`[WS] New: ${msg.token.symbol}`);
          processTokens([msg.token]);
        }
      };

      ws.onclose = () => {
        if (destroyed) return;
        console.log("[WS] Disconnected, reconnecting in 1s...");
        reconnectTimeout = setTimeout(connect, 1000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [scanning]);

  // FxTwitter fee recommendation check (async, non-blocking)
  const checkedRef = useRef<Set<string>>(new Set());
  const recommendedTweetsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (tokens.length === 0) return;

    const unchecked = tokens.filter(
      (t) => !checkedRef.current.has(t.contract_address) && getTweetUrl(t)
    );
    if (unchecked.length === 0) return;

    const batch = unchecked.slice(0, 3);
    batch.forEach((token) => {
      checkedRef.current.add(token.contract_address);
      const tweetUrl = getTweetUrl(token)!;

      fetch(`/api/tweet-info?url=${encodeURIComponent(tweetUrl)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data?.tweet_text || !data?.reply_to_username) return;
          const matchedUser = detectFeeRecommendation(data.tweet_text, data.reply_to_username);
          if (matchedUser) {
            const tweetId = getTweetId(tweetUrl);
            // Synchronous ref check beats any race condition between concurrent fetches
            const isDuplicate = tweetId ? recommendedTweetsRef.current.has(tweetId) : false;
            if (!isDuplicate && tweetId) {
              recommendedTweetsRef.current.add(tweetId);
            }
            setTokens((prev) =>
              prev.map((t) =>
                t.contract_address === token.contract_address
                  ? {
                      ...t,
                      recommended: true,
                      recommended_for: matchedUser,
                      duplicate_recommendation: isDuplicate,
                    }
                  : t
              )
            );
          }
        })
        .catch(() => {});
    });
  }, [tokens]);

  return (
    <main className="min-h-screen bg-[#0d1117]">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#0d1117] border-b border-[#00d9ff]/20">
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-2xl font-bold font-mono tracking-wider text-[#00d9ff]">
            CLANKER SCANNER
          </h1>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setScanning(!scanning)}
              className={`px-3 py-1 font-mono text-sm border ${
                scanning
                  ? "border-[#00ff88] text-[#00ff88]"
                  : "border-gray-500 text-gray-500"
              }`}
            >
              {scanning ? "● LIVE" : "○ PAUSED"}
            </button>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={searchCA}
                onChange={(e) => setSearchCA(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Search CA..."
                className="px-3 py-1 font-mono text-sm bg-[#161b22] border border-[#30363d] text-[#00d9ff] placeholder-gray-500 focus:outline-none focus:border-[#00d9ff] w-48"
              />
              <button
                onClick={handleSearch}
                className="px-3 py-1 font-mono text-sm border border-[#00d9ff]/50 text-[#00d9ff] hover:bg-[#00d9ff]/10"
              >
                FIND
              </button>
            </div>
          </div>
        </div>
      </header>

      {error && (
        <div className="max-w-[1800px] mx-auto px-4 py-2">
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-400 font-mono text-sm">
            {error}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="max-w-[1800px] mx-auto px-4 py-6">
        <div className="flex gap-6">
          {/* Main feed */}
          <div className="flex-1 min-w-0">
            {tokens.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-32 text-gray-500 font-mono">
                <div className="text-4xl mb-4">◉</div>
                <div>Watching for new deploys...</div>
              </div>
            ) : (
              <div className="max-w-3xl mx-auto space-y-4">
                {tokens.map((token, index) => (
                  <div key={token.contract_address} id={`token-${token.contract_address}`}>
                    <TokenCard
                      token={token}
                      isLatest={index === 0}
                      onTweetDeleted={() => handleTweetDeleted(token.contract_address)}
                      shouldFetchStats={newTokensRef.current.has(token.contract_address)}
                      botDomain={botDomain}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sidebar - Recent tokens */}
          <div className="hidden lg:block w-72 flex-shrink-0">
            <div className="sticky top-20 bg-[#161b22] border border-[#30363d] rounded-sm">
              <div className="px-3 py-2 border-b border-[#30363d]">
                <span className="font-mono text-sm text-[#00d9ff]">RECENT ({tokens.length})</span>
              </div>
              <div className="max-h-[calc(100vh-8rem)] overflow-y-auto">
                {tokens.map((token, index) => {
                  const timeAgo = Math.floor((Date.now() - new Date(token.created_at).getTime()) / 1000);
                  const timeStr = timeAgo < 60 ? `${timeAgo}s` : timeAgo < 3600 ? `${Math.floor(timeAgo / 60)}m` : `${Math.floor(timeAgo / 3600)}h`;

                  return (
                    <button
                      key={token.contract_address}
                      onClick={() => {
                        document.getElementById(`token-${token.contract_address}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }}
                      className={`w-full px-3 py-2 flex items-center justify-between hover:bg-[#30363d]/50 transition-colors text-left ${token.recommended && !token.duplicate_recommendation ? "bg-[#a855f7]/10 border-l-2 border-[#a855f7]" : index === 0 ? "bg-[#00ff88]/5" : ""}`}
                    >
                      <div className="min-w-0">
                        <div className={`font-mono text-sm truncate ${token.recommended && !token.duplicate_recommendation ? "text-[#a855f7]" : "text-white"}`}>${token.symbol}</div>
                        <div className="font-mono text-xs text-gray-500">{timeStr} ago</div>
                      </div>
                      <span className={`font-mono text-xs ${
                        mcaps[token.contract_address] >= 25000 ? 'text-[#00ff88]' : 'text-yellow-400'
                      }`}>
                        {mcaps[token.contract_address]
                          ? `$${mcaps[token.contract_address] >= 1000000
                              ? (mcaps[token.contract_address] / 1000000).toFixed(1) + 'M'
                              : mcaps[token.contract_address] >= 1000
                                ? (mcaps[token.contract_address] / 1000).toFixed(0) + 'K'
                                : mcaps[token.contract_address].toFixed(0)}`
                          : '...'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
