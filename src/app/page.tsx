"use client";

import { useEffect, useState, useRef } from "react";
import { ClankerToken, hasRealSocialContext } from "@/types";
import { TokenCard } from "@/components/TokenCard";

export default function Home() {
  const [tokens, setTokens] = useState<ClankerToken[]>([]);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mcaps, setMcaps] = useState<Record<string, number>>({});
  const seenRef = useRef<Set<string>>(new Set());
  const deletedRef = useRef<Set<string>>(new Set());
  const [, setTick] = useState(0);
  const [searchCA, setSearchCA] = useState("");

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

  // Fetch and update mcaps for sidebar - runs every 3 seconds
  useEffect(() => {
    const fetchAllMcaps = async () => {
      tokens.forEach(async (token) => {
        try {
          const res = await fetch(`/api/mcap/${token.contract_address}`);
          const data = await res.json();
          if (data.mcap !== null && data.mcap !== undefined) {
            setMcaps((prev) => ({ ...prev, [token.contract_address]: data.mcap }));
          }
        } catch {}
      });
    };

    // Fetch immediately when tokens change
    fetchAllMcaps();

    // Then fetch every 3 seconds to update mcaps in real-time
    const interval = setInterval(fetchAllMcaps, 3000);
    return () => clearInterval(interval);
  }, [tokens]);

  useEffect(() => {
    if (!scanning) return;

    async function fetchTokens() {
      try {
        // Use webhook endpoint instead of direct Clanker API polling
        const res = await fetch("/api/webhook");
        if (!res.ok) {
          setError(`API error: ${res.status}`);
          return;
        }

        const data = await res.json();
        const newTokens: ClankerToken[] = data.data || [];
        console.log(`[Scanner] Fetched ${newTokens.length} tokens from webhook`);
        setError(null);

        const unseen = newTokens.filter(
          (t) => !seenRef.current.has(t.contract_address) && !deletedRef.current.has(t.contract_address) && hasRealSocialContext(t)
        );
        console.log(`[Scanner] ${unseen.length} tokens passed filter (${newTokens.length - unseen.length} filtered out)`);

        if (newTokens.length > 0 && unseen.length === 0) {
          console.log('[Scanner] All tokens filtered out! First token:', newTokens[0]);
          console.log('[Scanner] hasRealSocialContext result:', hasRealSocialContext(newTokens[0]));
        }

        if (unseen.length > 0) {
          unseen.forEach((t) => seenRef.current.add(t.contract_address));
          setTokens((prev) => [...unseen, ...prev].slice(0, 50));
        }
      } catch (e) {
        console.error('[Scanner] Fetch error:', e);
        setError(`Network error`);
      }
    }

    fetchTokens();
    const interval = setInterval(fetchTokens, 1000);
    return () => clearInterval(interval);
  }, [scanning]);

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
                    <TokenCard token={token} isLatest={index === 0} onTweetDeleted={() => handleTweetDeleted(token.contract_address)} />
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
              <div className="max-h-[70vh] overflow-y-auto">
                {tokens.slice(0, 15).map((token, index) => {
                  const timeAgo = Math.floor((Date.now() - new Date(token.created_at).getTime()) / 1000);
                  const timeStr = timeAgo < 60 ? `${timeAgo}s` : timeAgo < 3600 ? `${Math.floor(timeAgo / 60)}m` : `${Math.floor(timeAgo / 3600)}h`;

                  return (
                    <button
                      key={token.contract_address}
                      onClick={() => {
                        document.getElementById(`token-${token.contract_address}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }}
                      className={`w-full px-3 py-2 flex items-center justify-between hover:bg-[#30363d]/50 transition-colors text-left ${index === 0 ? "bg-[#00ff88]/5" : ""}`}
                    >
                      <div className="min-w-0">
                        <div className="font-mono text-sm text-white truncate">${token.symbol}</div>
                        <div className="font-mono text-xs text-gray-500">{timeStr} ago</div>
                      </div>
                      <span className={`font-mono text-xs ${
                        mcaps[token.contract_address] >= 35000 ? 'text-[#00ff88]' : 'text-yellow-400'
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
