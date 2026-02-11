"use client";

import { useState, useEffect } from "react";
import { ClankerToken, getTwitterUsername, getTweetId, getTweetUrl, getCastUrl } from "@/types";
import { TweetEmbed } from "./TweetEmbed";
import { executeBuy } from "@/lib/swap";

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const created = new Date(dateStr).getTime();
  const diffMs = now - created;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);

  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}


export function TokenCard({ token, isLatest, onTweetDeleted, shouldFetchStats = false, walletKey = null, buyAmount = "0.005", mcap = null }: { token: ClankerToken; isLatest?: boolean; onTweetDeleted?: () => void; shouldFetchStats?: boolean; walletKey?: string | null; buyAmount?: string; mcap?: number | null }) {
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0);
  const [buyState, setBuyState] = useState<"idle" | "sending" | "pending" | "confirmed" | "reverted" | "error">("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [twitterStats, setTwitterStats] = useState<{
    replied_to_username: string;
    replied_to_followers: number;
    replied_to_followers_text: string;
  } | null>(token.twitter_stats || null);

  // Update timestamp every second (also drives fee countdown)
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Fee countdown for Clanker AI — Sniper Auction V2 (quadratic decay)
  // fee = endingFee + feeRange * (timeRemaining / timeToDecay)²
  // On-chain: 66.7% → 4.2% over 15s (auction), then 1% base LP fee
  const FEE_DURATION = 15;
  const isClanker = token.factory_type === "clanker";
  const secondsSinceDeploy = Math.floor((Date.now() - new Date(token.created_at).getTime()) / 1000);
  const feeRemaining = isClanker ? Math.max(0, FEE_DURATION - secondsSinceDeploy) : 0;
  const hasFee = feeRemaining > 0;


  const tweetUrl = getTweetUrl(token);
  const castUrl = getCastUrl(token);

  // Detect platform from Railway format (twitter_link) or old format (social_context.platform)
  const hasTwitter = !!tweetUrl;
  const hasFarcaster = !!castUrl;
  const platform = hasTwitter ? "X" : hasFarcaster ? "FARCASTER" : (token.social_context?.platform?.toUpperCase() || "UNKNOWN");

  const messageUrl = token.social_context?.messageId || token.cast_hash || "";

  const tweetId = getTweetId(messageUrl)
    || getTweetId(token.social_context?.id || "")
    || (tweetUrl ? getTweetId(tweetUrl) : null);

  const twitterUser = getTwitterUsername(messageUrl) || (tweetUrl ? getTwitterUsername(tweetUrl) : null);

  // Extract replied-to username from tweet URL and fetch stats (only for new tokens)
  useEffect(() => {
    if (!shouldFetchStats || !tweetUrl || twitterStats) return; // Skip if not a new token, no tweet URL, or already have stats

    const extractAndFetchStats = async () => {
      try {
        // Use API to extract the replied-to user from tweet
        const res = await fetch(`/api/extract-reply-to?url=${encodeURIComponent(tweetUrl)}`);
        const data = await res.json();

        if (data.replied_to_username) {
          // Fetch smart followers for this user
          const statsRes = await fetch(`/api/twitter-stats/${data.replied_to_username}`);
          const statsData = await statsRes.json();

          if (statsData.smart_followers !== undefined && statsData.smart_followers !== null) {
            const formatCount = (count: number) => {
              if (count >= 1000000) return (count / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
              if (count >= 1000) return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
              return count.toString();
            };

            setTwitterStats({
              replied_to_username: data.replied_to_username,
              replied_to_followers: statsData.smart_followers,
              replied_to_followers_text: formatCount(statsData.smart_followers)
            });
          }
        }
      } catch (e) {
        console.log('Failed to fetch Twitter stats:', e);
      }
    };

    extractAndFetchStats();
  }, [tweetUrl, twitterStats]);

  const copyCA = () => {
    navigator.clipboard.writeText(token.contract_address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`rounded-sm overflow-hidden ${token.recommended && !token.duplicate_recommendation ? "border-2 border-[#a855f7]" : "border border-[#30363d]"} ${isClanker ? "bg-[#1c1408]" : "bg-[#0c1222]"}`}>
      {/* Header */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          {/* Left side - Token info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              {isLatest && (
                <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-[#00d9ff] text-black rounded-sm">
                  LATEST
                </span>
              )}
              {token.recommended && !token.duplicate_recommendation && (
                <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-[#ef4444] text-white rounded-full">
                  AI recommended
                </span>
              )}
              {token.duplicate_recommendation && (
                <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-[#f97316] text-black rounded-sm flex items-center gap-1">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  COPYCAT
                </span>
              )}
              <span className="text-gray-500 font-mono text-xs">
                {formatTimeAgo(token.created_at)}
              </span>
              {platform === "X" && (
                <svg className={`w-4 h-4 ${isClanker ? "text-[#f97316]" : "text-[#00d9ff]"}`} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              )}
              {platform === "FARCASTER" && (
                <span className="text-purple-400 font-mono text-sm">FC</span>
              )}
            </div>
            <h2 className={`text-2xl font-mono font-bold truncate ${isClanker ? "text-[#f97316]" : "text-[#00d9ff]"}`}>{token.name}</h2>
            <div className="flex items-center gap-3">
              <p className={`text-lg font-mono ${isClanker ? "text-[#f97316]" : "text-[#00ff88]"}`}>${token.symbol}</p>
              {mcap !== null && (
                <span className={`text-lg font-mono font-bold ${mcap >= 35000 ? 'text-[#00ff88]' : 'text-yellow-400'}`}>
                  MC: ${mcap >= 1000000 ? (mcap / 1000000).toFixed(1) + 'M' : mcap >= 1000 ? (mcap / 1000).toFixed(1) + 'K' : mcap.toFixed(0)}
                </span>
              )}
            </div>
          </div>

          {/* Right side - Twitter stats only */}
          <div className="flex-shrink-0">
            {twitterStats && (
              <a
                href={`https://x.com/${twitterStats.replied_to_username}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`flex flex-col items-center justify-center gap-2 px-6 py-4 border-2 rounded-lg transition-all min-w-[200px] ${isClanker ? "bg-orange-500/10 border-orange-500/30 hover:bg-orange-500/20 hover:border-orange-500/50" : "bg-blue-500/10 border-blue-500/30 hover:bg-blue-500/20 hover:border-blue-500/50"}`}
              >
                <div className="flex items-center gap-2">
                  <svg className={`w-5 h-5 ${isClanker ? "text-orange-400" : "text-blue-400"}`} fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  <span className={`text-xl font-mono font-bold ${isClanker ? "text-orange-400" : "text-blue-400"}`}>
                    {twitterStats.replied_to_followers_text}
                  </span>
                </div>
                <p className={`text-xs font-mono ${isClanker ? "text-orange-300" : "text-blue-300"}`}>Smart Followers</p>
                <p className={`text-xs font-mono ${isClanker ? "text-orange-300" : "text-blue-300"}`}>
                  Reply to @{twitterStats.replied_to_username}
                </p>
              </a>
            )}
          </div>
        </div>

        {/* CA & Links row */}
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <button
            onClick={copyCA}
            className={`flex items-center gap-1 font-mono text-xs px-2 py-1 rounded transition-colors ${isClanker ? "text-[#f97316] hover:bg-[#f97316]/10" : "text-[#00d9ff] hover:bg-[#00d9ff]/10"}`}
          >
            <span className="text-gray-500">CA:</span>
            {token.contract_address.slice(0, 10)}...{token.contract_address.slice(-6)}
            <svg className="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {copied && <span className="text-[#00ff88] ml-1">copied!</span>}
          </button>

          <a
            href={`https://gmgn.ai/base/token/${token.contract_address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[#00ff88] font-mono text-xs hover:bg-[#00ff88]/10 px-2 py-1 rounded transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 3v18h18V3H3zm16 16H5V5h14v14zM7 7h2v10H7V7zm4 4h2v6h-2v-6zm4-2h2v8h-2V9z" />
            </svg>
            GMGN
          </a>

          {token.msg_sender && (
            <a
              href={`https://basescan.org/address/${token.msg_sender}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-gray-400 font-mono text-xs hover:bg-gray-500/10 px-2 py-1 rounded transition-colors"
            >
              <span className="text-gray-500">Deployer:</span>
              {token.msg_sender.slice(0, 6)}...{token.msg_sender.slice(-4)}
            </a>
          )}
        </div>

        {/* Fee recommendation info */}
        {token.recommended && token.recommended_for && !token.duplicate_recommendation && (
          <div className="mt-2 px-3 py-2 bg-[#a855f7]/10 border border-[#a855f7]/30 rounded">
            <span className="font-mono text-xs text-[#a855f7]">
              Fees directed to @{token.recommended_for} (thread owner)
            </span>
          </div>
        )}
        {token.duplicate_recommendation && token.recommended_for && (
          <div className="mt-2 px-3 py-2 bg-[#a855f7]/10 border border-[#a855f7]/30 rounded">
            <span className="font-mono text-xs text-[#f97316]">
              Copycat — another token already deployed from this tweet for @{token.recommended_for}
            </span>
          </div>
        )}

        {/* Buy button */}
        {walletKey ? (
          (() => {
            const feePercent = hasFee ? Math.round(4.2 + 62.5 * Math.pow(feeRemaining / FEE_DURATION, 2)) : 0;
            const feeColor = feePercent > 40 ? "#ff4444" : feePercent > 20 ? "#ff8800" : feePercent > 10 ? "#ffcc00" : "#00ff88";
            const progress = hasFee ? Math.min(100, (secondsSinceDeploy / FEE_DURATION) * 100) : 100;

            return (
              <button
                onClick={async () => {
                  if (buyState === "sending" || buyState === "pending") return;
                  setBuyState("sending");
                  try {
                    const hash = await executeBuy(walletKey, token.contract_address, buyAmount, token.factory_type || "bankr");
                    setTxHash(hash);
                    setBuyState("pending");
                    const rpc = "https://mainnet.base.org";
                    for (let i = 0; i < 30; i++) {
                      await new Promise(r => setTimeout(r, 1000));
                      try {
                        const res = await fetch(rpc, {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
                        });
                        const json = await res.json();
                        if (json.result) {
                          const success = json.result.status === "0x1";
                          setBuyState(success ? "confirmed" : "reverted");
                          setTimeout(() => setBuyState("idle"), 10000);
                          return;
                        }
                      } catch {}
                    }
                    setBuyState("confirmed");
                    setTimeout(() => setBuyState("idle"), 10000);
                  } catch (e: any) {
                    setBuyError(e.message?.slice(0, 60) || "Transaction failed");
                    setBuyState("error");
                    setTimeout(() => { setBuyState("idle"); setBuyError(null); }, 5000);
                  }
                }}
                disabled={buyState === "sending" || buyState === "pending"}
                className={`mt-3 relative overflow-hidden flex items-center justify-center gap-2 w-full py-2.5 rounded font-semibold text-sm transition-colors ${
                  buyState === "confirmed"
                    ? "bg-[#00ff88]/20 border border-[#00ff88]/50 text-[#00ff88]"
                    : buyState === "reverted"
                    ? "bg-red-500/20 border border-red-500/50 text-red-400"
                    : buyState === "error"
                    ? "bg-red-500/20 border border-red-500/50 text-red-400"
                    : buyState === "sending"
                    ? "bg-yellow-500/20 border border-yellow-500/50 text-yellow-400 cursor-wait"
                    : buyState === "pending"
                    ? "bg-yellow-500/20 border border-yellow-500/50 text-yellow-400 cursor-wait"
                    : hasFee
                    ? "bg-[#0d1117] border border-[#30363d] text-white"
                    : "bg-[#00ff88]/10 border border-[#00ff88]/30 text-[#00ff88] hover:bg-[#00ff88]/20"
                }`}
              >
                {/* Fee progress bar background — fills left→right as fee decays */}
                {hasFee && buyState === "idle" && (
                  <div
                    className="absolute inset-0 transition-all duration-1000"
                    style={{
                      width: `${progress}%`,
                      background: `linear-gradient(90deg, #ff4444, #ff8800, #ffcc00, #00ff88)`,
                      opacity: 0.25,
                    }}
                  />
                )}
                <span className="relative z-10">
                  {buyState === "sending" && "SENDING..."}
                  {buyState === "pending" && txHash && (
                    <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                      PENDING... View tx &rarr;
                    </a>
                  )}
                  {buyState === "confirmed" && txHash && (
                    <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                      CONFIRMED! View tx &rarr;
                    </a>
                  )}
                  {buyState === "reverted" && txHash && (
                    <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                      REVERTED! View tx &rarr;
                    </a>
                  )}
                  {buyState === "error" && `FAILED: ${buyError}`}
                  {buyState === "idle" && (hasFee
                    ? <>BUY {buyAmount} ETH <span style={{ color: feeColor }}>({feePercent}% fee)</span> <span className="text-gray-400">{feeRemaining}s</span></>
                    : `BUY ${buyAmount} ETH`)}
                </span>
              </button>
            );
          })()
        ) : (
          <div className="mt-3 text-center text-[10px] text-gray-500 font-mono py-1.5">
            Import wallet above to enable instant buy
          </div>
        )}

        {/* Social Links - dedupe by URL */}
        {(() => {
          const links = token.socialLinks || [];
          const seenUrls = new Set<string>();
          const uniqueLinks = links.filter(l => {
            if (!l.link || seenUrls.has(l.link)) return false;
            seenUrls.add(l.link);
            return true;
          });

          if (uniqueLinks.length === 0) return null;

          return (
            <div className="mt-3 flex items-center gap-3">
              {uniqueLinks.map((link, i) => (
                <a
                  key={i}
                  href={link.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 border border-[#30363d] rounded hover:bg-[#30363d]/50 transition-colors"
                >
                  {link.name === "website" && (
                    <svg className="w-5 h-5 text-[#00d9ff]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                    </svg>
                  )}
                  {link.name === "x" && (
                    <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                    </svg>
                  )}
                  {link.name === "github" && (
                    <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                    </svg>
                  )}
                  {link.name === "telegram" && (
                    <svg className="w-5 h-5 text-[#26A5E4]" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                    </svg>
                  )}
                  {!["website", "x", "github", "telegram"].includes(link.name) && (
                    <span className="text-gray-400 text-sm font-mono">{link.name}</span>
                  )}
                </a>
              ))}
            </div>
          );
        })()}
      </div>

      {/* Tweet Embed - only for X platform */}
      {tweetId && platform === "X" && (
        <div className="border-t border-[#30363d] p-3">
          <TweetEmbed tweetId={tweetId} contractAddress={token.contract_address} onDeleted={onTweetDeleted} />
        </div>
      )}

      {/* Metadata JSON box - for tokens without tweet/cast (InstaClaw, Basenames, terminal etc.) */}
      {!tweetId && !castUrl && (token.description || token.social_context?.interface) && (
        <div className="border-t border-[#30363d] p-3">
          <pre className="font-mono text-xs text-gray-400 bg-[#0d1117] border border-[#30363d] rounded p-3 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify({
              description: token.description || undefined,
              socialMediaUrls: token.metadata?.socialMediaUrls?.map(s => s.url) || [],
              auditUrls: [],
              interface: token.social_context?.interface || undefined,
              platform: token.social_context?.platform || undefined,
            }, null, 2)}
          </pre>
        </div>
      )}

      {/* Farcaster link - always show for FC tokens with cast hash */}
      {castUrl && (
        <div className="border-t border-[#30363d] px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <a
              href={castUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-purple-400 font-mono text-sm hover:bg-purple-400/10 px-2 py-1 rounded transition-colors"
            >
              <span className="text-purple-500">FC</span>
              View Cast on Warpcast →
            </a>
            {token.social_context?.xUsername && (
              <a
                href={`https://x.com/${token.social_context.xUsername}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[#00d9ff] font-mono text-sm hover:bg-[#00d9ff]/10 px-2 py-1 rounded transition-colors"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                @{token.social_context.xUsername}
              </a>
            )}
          </div>
        </div>
      )}


    </div>
  );
}
