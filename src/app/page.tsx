"use client";

import { useEffect, useState, useRef } from "react";
import { ClankerToken, hasRealSocialContext } from "@/types";
import { TokenCard } from "@/components/TokenCard";

export default function Home() {
  const [tokens, setTokens] = useState<ClankerToken[]>([]);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!scanning) return;

    async function fetchTokens() {
      try {
        const res = await fetch("/api/tokens");
        if (!res.ok) {
          setError(`API error: ${res.status}`);
          return;
        }

        const data = await res.json();
        const newTokens: ClankerToken[] = data.data || [];
        setError(null);

        const unseen = newTokens.filter(
          (t) => !seenRef.current.has(t.contract_address) && hasRealSocialContext(t)
        );

        if (unseen.length > 0) {
          unseen.forEach((t) => seenRef.current.add(t.contract_address));
          setTokens((prev) => [...unseen, ...prev].slice(0, 50));
        }
      } catch (e) {
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
            <button
              onClick={() => setTokens([])}
              className="px-3 py-1 font-mono text-sm border border-[#00d9ff]/50 text-[#00d9ff] hover:bg-[#00d9ff]/10"
            >
              CLR [{tokens.length}]
            </button>
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
        {tokens.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 text-gray-500 font-mono">
            <div className="text-4xl mb-4">◉</div>
            <div>Watching for new deploys...</div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-4">
            {tokens.map((token, index) => (
              <TokenCard key={token.contract_address} token={token} isLatest={index === 0} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
