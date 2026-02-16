require('dotenv').config();
const { ethers } = require('ethers');
const http = require('http');
const { WebSocketServer } = require('ws');

// Environment variables
const WSS_URLS = [
  process.env.WSS_URL,           // Primary RPC
  process.env.WSS_URL_BACKUP     // Backup RPC (optional)
].filter(Boolean); // Remove undefined/null entries

// In-memory token buffer
const recentTokens = []; // Most recent first
const MAX_TOKENS = 50;
const seenContracts = new Set(); // Dedup — prevent broadcasting same token twice

// Periodically trim seenContracts to prevent unbounded growth
setInterval(() => {
  if (seenContracts.size > 500) {
    const arr = [...seenContracts];
    seenContracts.clear();
    arr.slice(-200).forEach(a => seenContracts.add(a));
  }
}, 30_000);

// ---- WebSocket Server for direct browser push ----
const WS_PORT = parseInt(process.env.PORT) || 3001;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: wsClients.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`[WS] Client connected (${wsClients.size} total)`);

  if (recentTokens.length > 0) {
    ws.send(JSON.stringify({ type: 'init', tokens: recentTokens }));
  }

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected (${wsClients.size} total)`);
  });

  ws.on('error', () => wsClients.delete(ws));
});

// Heartbeat every 30s to keep connections alive
setInterval(() => {
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.ping();
  }
}, 30_000);

function broadcastToken(tokenData) {
  // Dedup — skip if we already broadcast this contract address
  const ca = tokenData.contract_address.toLowerCase();
  if (seenContracts.has(ca)) {
    console.log(`[WS] Skipping duplicate ${tokenData.symbol || 'Token'} (${ca.slice(0, 10)}...)`);
    return;
  }
  seenContracts.add(ca);

  recentTokens.unshift(tokenData);
  if (recentTokens.length > MAX_TOKENS) recentTokens.length = MAX_TOKENS;

  const msg = JSON.stringify({ type: 'token', token: tokenData });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
  console.log(`[WS] Broadcasted ${tokenData.symbol || 'Unknown'} to ${wsClients.size} clients (buffer: ${recentTokens.length})`);
}

server.listen(WS_PORT, () => {
  console.log(`🌐 WebSocket server listening on port ${WS_PORT}`);
});

// ---- Aggressive BankrFindr Logic ----

const TARGET_SELECTOR = 'e9ae5c53';
const IPFS_PREFIX_HEX = '697066733a2f2f'; // ipfs://

// ---- Clanker AI Factory ----
const CLANKER_AI_FACTORY = '0xe85a59c628f7d27878aceb4bf3b35733630083a9'; // lowercased
const CLANKER_AI_EVENT_TOPIC = '0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67';
const abiCoder = new ethers.AbiCoder();

// ---- Neynar (Farcaster API) ----
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || '4B216F81-7DB6-4299-976B-C732EC756720';

async function lookupFarcasterCast(castHash) {
  try {
    const identifier = castHash.startsWith('0x') ? castHash : `0x${castHash}`;
    const res = await fetch(
      `https://api.neynar.com/v2/farcaster/cast?identifier=${identifier}&type=hash`,
      { headers: { 'api_key': NEYNAR_API_KEY }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const cast = data.cast;
    if (!cast) return null;

    let author = cast.author || {};
    let castText = cast.text || '';

    // If author is the clanker bot, follow parent_hash to get the real requester
    const botUsernames = ['clanker', 'bankr', 'bankrbot'];
    if (botUsernames.includes(author.username?.toLowerCase()) && cast.parent_hash) {
      try {
        const parentRes = await fetch(
          `https://api.neynar.com/v2/farcaster/cast?identifier=${cast.parent_hash}&type=hash`,
          { headers: { 'api_key': NEYNAR_API_KEY }, signal: AbortSignal.timeout(5000) }
        );
        if (parentRes.ok) {
          const parentData = await parentRes.json();
          const parentCast = parentData.cast;
          if (parentCast?.author) {
            author = parentCast.author;
            castText = parentCast.text || castText;
            console.log(`   📌 Parent cast: @${author.username} (${author.follower_count} followers)`);
          }
        }
      } catch (e) {
        console.log(`⚠️ Parent cast lookup failed: ${e.message}`);
      }
    }

    const xAccount = (author.verified_accounts || []).find(a => a.platform === 'x');

    return {
      cast_text: castText,
      author_username: author.username || '',
      author_display_name: author.display_name || '',
      author_pfp: author.pfp_url || null,
      author_fid: author.fid || null,
      follower_count: author.follower_count || 0,
      following_count: author.following_count || 0,
      bio: author.profile?.bio?.text || '',
      power_badge: author.power_badge || false,
      x_username: xAccount?.username || null,
    };
  } catch (e) {
    console.log(`⚠️ Neynar cast lookup failed: ${e.message}`);
    return null;
  }
}

// ---- Virtuals Protocol Factory ----
const VIRTUALS_FACTORY = '0xa31bd6a0edbc4da307b8fa92bd6cf39e0fae262c'; // lowercased
const VIRTUALS_PRELAUNCH_EVENT = '0xac073481b1bc4233bf4afdfbb03f87ea97b0bb2c0305808d5614c824afb4e8b0';

// ---- Noice (Doppler Protocol) ----
const NOICE_DEPLOYER = '0xe8d333d606d29e89ed4364c1ee0de4a694ad9cd1'; // smart account (executeBatch)

// Whitelist of legitimate Clanker deployer addresses (lowercase)
const WHITELISTED_DEPLOYERS = new Set([
  '0x2112b8456ac07c15fa31ddf3bf713e77716ff3f9',
  '0xd9acd656a5f1b519c9e76a2a6092265a74186e58',
]);

let currentUrlIndex = 0;
let provider;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Extract IPFS CID from hex calldata
function extractIpfsCid(data) {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  const ipfsIdx = hex.indexOf(IPFS_PREFIX_HEX);
  if (ipfsIdx === -1) return null;

  let ipfs = '';
  for (let i = ipfsIdx; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (byte >= 32 && byte <= 126) {
      ipfs += String.fromCharCode(byte);
    } else {
      break;
    }
  }
  return ipfs.replace('ipfs://', '') || null;
}

// Find deployed token address from receipt Transfer(0x0 → X) mint event
function extractTokenAddress(receipt) {
  if (!receipt || !receipt.logs) return null;
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const zeroTopic = '0x0000000000000000000000000000000000000000000000000000000000000000';
  for (const log of receipt.logs) {
    if (log.topics[0] === transferTopic && log.topics[1] === zeroTopic) {
      return log.address;
    }
  }
  return null;
}

// Fetch IPFS metadata from multiple gateways (race for fastest)
async function fetchIpfsMetadata(ipfsCid) {
  const gateways = [
    'https://ipfs.io/ipfs/',
    'https://content.wrappr.wtf/ipfs/',
    'https://dweb.link/ipfs/',
    'https://nftstorage.link/ipfs/'
  ];

  return Promise.any(
    gateways.map(async (base) => {
      const res = await fetch(`${base}${ipfsCid}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return { data, gatewayBase: base };
    })
  );
}

// Process a Clanker AI factory tx — parse event logs directly (no IPFS needed)
async function processClankerAiTx(tx, receipt, t0, blockTimestamp) {
  try {
    // Find the factory event log
    const factoryLog = receipt.logs.find(
      log => log.topics[0] === CLANKER_AI_EVENT_TOPIC
        && log.address.toLowerCase() === CLANKER_AI_FACTORY
    );
    if (!factoryLog) {
      console.log('⚠️ Clanker AI tx but no factory event found. Skipping.');
      return;
    }

    // Token address from topic1 (indexed)
    const tokenAddress = ethers.getAddress('0x' + factoryLog.topics[1].slice(26));

    // Decode event data: (address deployer, uint256 id, string name, string symbol, string empty, string socialContextJSON, int24 tick, address hook, bytes32 poolId, uint256 extra)
    const decoded = abiCoder.decode(
      ['address', 'uint256', 'string', 'string', 'string', 'string', 'int24', 'address', 'bytes32', 'uint256'],
      factoryLog.data
    );

    const name = decoded[2] || 'Unknown';
    const symbol = decoded[3] || '???';
    const socialContextRaw = decoded[5] || '{}';

    // Check deployer whitelist
    const deployer = tx.from?.toLowerCase();
    if (!deployer || !WHITELISTED_DEPLOYERS.has(deployer)) {
      console.log(`⚠️ Clanker AI: Deployer ${deployer || 'unknown'} not whitelisted, skipping scam`);
      return;
    }

    let socialContext = {};
    try { socialContext = JSON.parse(socialContextRaw); } catch {}

    // Skip clank.fun deploys (no useful social context)
    const iface = (socialContext.interface || '').toLowerCase();
    if (iface === 'clank.fun') {
      console.log(`⚠️ Clanker AI: Skipping clank.fun deploy for ${symbol}`);
      return;
    }

    const platform = (socialContext.platform || '').toLowerCase();
    const messageId = socialContext.messageId || '';

    // Only show tokens deployed from Twitter/X or Farcaster
    if (platform !== 'twitter' && platform !== 'x' && platform !== 'farcaster') {
      console.log(`⚠️ Clanker AI: Skipping unknown platform "${platform}" for ${symbol}`);
      return;
    }

    const isFarcaster = platform === 'farcaster';

    if (isFarcaster) {
      // Farcaster deploy — messageId is cast hash
      const castHash = messageId || null;
      if (!castHash) {
        console.log(`⚠️ Clanker AI: No cast hash for Farcaster deploy ${symbol}. Skipping.`);
        return;
      }

      // Neynar lookup — get author profile, bio, followers, X handle
      const fcStats = await lookupFarcasterCast(castHash);

      const normalizedHash = castHash.startsWith('0x') ? castHash : `0x${castHash}`;
      broadcastToken({
        contract_address: tokenAddress,
        name,
        symbol,
        tx_hash: tx.hash,
        created_at: blockTimestamp,
        creator_address: tx.from,
        image_url: null,
        description: null,
        twitter_link: fcStats?.x_username ? `https://x.com/${fcStats.x_username}` : null,
        cast_hash: normalizedHash,
        factory_type: 'clanker',
        farcaster_stats: fcStats || null,
        social_context: {
          interface: 'clanker',
          platform: 'Farcaster',
          messageId: castHash,
          xUsername: fcStats?.x_username || null,
        },
      });

      console.log(`✅ [Clanker AI] ${name} ($${symbol}) — ${tokenAddress}`);
      console.log(`   Farcaster: https://warpcast.com/~/conversations/${castHash}`);
      if (fcStats) {
        console.log(`   Author: @${fcStats.author_username} (${fcStats.follower_count} followers${fcStats.power_badge ? ', ⚡ power' : ''})`);
        if (fcStats.x_username) console.log(`   X: @${fcStats.x_username}`);
        if (fcStats.bio) console.log(`   Bio: ${fcStats.bio.substring(0, 80)}`);
      }
      console.log(`   ⏱️  Total: ${(performance.now() - t0).toFixed(0)}ms`);
      console.log('\x1b[35m%s\x1b[0m', '----------------------------------------');
    } else {
      // Twitter/X deploy — messageId is tweet ID or URL
      const tweetUrl = messageId
        ? (messageId.startsWith('http') ? messageId : `https://x.com/i/status/${messageId}`)
        : null;
      if (!tweetUrl) {
        console.log(`⚠️ Clanker AI: No messageId for ${symbol}. Skipping.`);
        return;
      }

      broadcastToken({
        contract_address: tokenAddress,
        name,
        symbol,
        tx_hash: tx.hash,
        created_at: blockTimestamp,
        creator_address: tx.from,
        image_url: null,
        description: null,
        twitter_link: tweetUrl,
        factory_type: 'clanker',
        social_context: {
          interface: 'clanker',
          platform: 'X',
          messageId: tweetUrl,
        },
      });

      console.log(`✅ [Clanker AI] ${name} ($${symbol}) — ${tokenAddress}`);
      console.log(`   Tweet: ${tweetUrl}`);
      console.log(`   ⏱️  Total: ${(performance.now() - t0).toFixed(0)}ms`);
      console.log('\x1b[36m%s\x1b[0m', '----------------------------------------');
    }
  } catch (e) {
    console.error('[Clanker AI] Error processing tx:', e.message);
  }
}

// Process a Virtuals Protocol PreLaunch tx — query API for metadata + socials
async function processVirtualsTx(tx, receipt, t0, blockTimestamp) {
  try {
    // Find PreLaunch event log from the factory
    const prelaunchLog = receipt.logs.find(
      log => log.topics[0] === VIRTUALS_PRELAUNCH_EVENT
    );
    if (!prelaunchLog) {
      console.log('⚠️ Virtuals tx but no PreLaunch event found. Skipping.');
      return;
    }

    // preToken address from topic[1] (indexed)
    const preTokenAddress = ethers.getAddress('0x' + prelaunchLog.topics[1].slice(26));

    // Query Virtuals API for metadata + socials (retry with increasing delays)
    // API may not have indexed the token yet when the on-chain tx lands
    // No rush — 95% tax at launch means being 1 min late is fine for DD
    let apiData = null;
    const apiUrl = `https://api.virtuals.io/api/virtuals?filters[preToken][$eq]=${preTokenAddress}`;
    const retryDelays = [30000, 60000, 120000]; // 30s, 1min, 2min — no rush, 95% tax
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      try {
        console.log(`   [Virtuals] Querying API in ${retryDelays[attempt]/1000}s (attempt ${attempt + 1}/${retryDelays.length}) for ${preTokenAddress}...`);
        await new Promise(r => setTimeout(r, retryDelays[attempt]));
        const res = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const json = await res.json();
          apiData = json.data?.[0] || null;
          if (apiData) break; // Got data, stop retrying
        }
      } catch (e) {
        console.log(`⚠️ Virtuals API fetch failed for ${preTokenAddress}: ${e.message}`);
      }
    }
    if (!apiData) {
      console.log(`⚠️ Virtuals: API returned no data after ${retryDelays.length} attempts for ${preTokenAddress}. Skipping.`);
      return;
    }

    // --- ACP lookup (acpx.virtuals.io) for extra data: twitterHandle, success rate, jobs ---
    let acpData = null;
    const acpAgentId = apiData.acpAgentId;
    try {
      let acpUrl = null;
      if (acpAgentId) {
        acpUrl = `https://acpx.virtuals.io/api/agents/${acpAgentId}`;
      } else {
        // Fallback: search by token address
        acpUrl = `https://acpx.virtuals.io/api/agents?filters[tokenAddress][$eq]=${preTokenAddress}`;
      }
      const acpRes = await fetch(acpUrl, { signal: AbortSignal.timeout(5000) });
      if (acpRes.ok) {
        const acpJson = await acpRes.json();
        acpData = acpAgentId ? acpJson.data : acpJson.data?.[0] || null;
        if (acpData) {
          console.log(`   📊 ACP: @${acpData.twitterHandle || 'n/a'} | ${acpData.successRate || 0}% success | ${acpData.successfulJobCount || 0} jobs`);
        }
      }
    } catch (e) {
      console.log(`⚠️ ACP lookup failed: ${e.message}`);
    }

    // Extract socials — check Virtuals API, creator socials, then ACP fallback
    // Agent-level socials
    const socials = apiData.socials || {};
    let twitterUrl = socials.TWITTER || socials.twitter || socials.x || socials.X || socials.VERIFIED_LINKS?.TWITTER || null;
    let telegramUrl = socials.TELEGRAM || socials.telegram || socials.VERIFIED_LINKS?.TELEGRAM || null;
    let githubUrl = socials.GITHUB || socials.github || socials.VERIFIED_LINKS?.GITHUB || null;

    // Creator-level socials (fallback — "The Team" section on Virtuals)
    const creatorSocials = apiData.creator?.socials || {};
    const creatorLinks = creatorSocials.VERIFIED_LINKS || {};
    if (!twitterUrl) twitterUrl = creatorLinks.TWITTER || creatorLinks.twitter || null;
    if (!telegramUrl) telegramUrl = creatorLinks.TELEGRAM || creatorLinks.telegram || null;
    if (!githubUrl) githubUrl = creatorLinks.GITHUB || creatorLinks.github || null;

    // ACP fallback — twitterHandle from agdp.io data
    if (!twitterUrl && acpData?.twitterHandle) {
      twitterUrl = `https://x.com/${acpData.twitterHandle}`;
      console.log(`   🔗 Twitter from ACP: ${twitterUrl}`);
    }

    // FILTER: Skip tokens without any socials
    if (!twitterUrl && !telegramUrl && !githubUrl) {
      const name = apiData?.name || preTokenAddress.slice(0, 10);
      console.log(`⚠️ Virtuals: No socials for ${name} (${preTokenAddress}). Skipping.`);
      return;
    }

    // Build social links array for frontend
    const socialLinks = [];
    if (twitterUrl) socialLinks.push({ name: 'x', link: twitterUrl });
    if (telegramUrl) socialLinks.push({ name: 'telegram', link: telegramUrl });
    if (githubUrl) socialLinks.push({ name: 'github', link: githubUrl });

    const name = apiData?.name || 'Unknown';
    const symbol = apiData?.symbol || '???';
    const imageUrl = apiData?.image?.url || acpData?.profilePic || null;
    const description = apiData?.description || acpData?.description || null;
    const virtualsUrl = `https://app.virtuals.io/prototypes/${preTokenAddress}`;

    // ACP stats for frontend
    const acpStats = acpData ? {
      success_rate: acpData.successRate || 0,
      jobs_completed: acpData.successfulJobCount || 0,
      unique_buyers: acpData.uniqueBuyerCount || 0,
      rating: acpData.rating || null,
      twitter_handle: acpData.twitterHandle || null,
      acp_agent_id: acpData.id || acpAgentId,
    } : null;

    broadcastToken({
      contract_address: preTokenAddress,
      name,
      symbol,
      tx_hash: tx.hash,
      created_at: blockTimestamp,
      creator_address: tx.from,
      image_url: imageUrl,
      description,
      twitter_link: twitterUrl,
      factory_type: 'virtuals',
      virtuals_url: virtualsUrl,
      acp_stats: acpStats,
      socialLinks,
      social_context: {
        interface: 'Virtuals',
        platform: twitterUrl ? 'X' : 'Virtuals',
        messageId: twitterUrl || virtualsUrl,
      },
    });

    console.log(`✅ [Virtuals] ${name} ($${symbol}) — ${preTokenAddress}`);
    if (twitterUrl) console.log(`   Twitter: ${twitterUrl}`);
    if (telegramUrl) console.log(`   Telegram: ${telegramUrl}`);
    console.log(`   Virtuals: ${virtualsUrl}`);
    if (acpStats) console.log(`   ACP: ${acpStats.success_rate}% success, ${acpStats.jobs_completed} jobs, ${acpStats.unique_buyers} buyers`);
    console.log(`   ⏱️  Total: ${(performance.now() - t0).toFixed(0)}ms`);
    console.log('\x1b[32m%s\x1b[0m', '----------------------------------------');
  } catch (e) {
    console.error('[Virtuals] Error processing tx:', e.message);
  }
}

// Scrape a website for X/Twitter links (best-effort, short timeout)
async function scrapeForTwitter(url) {
  try {
    if (!url) return null;
    // Normalize URL
    if (!url.startsWith('http')) url = `https://${url}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Look for X/Twitter links in HTML (href, content, etc.)
    const patterns = [
      /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]{1,15})(?:\/|\?|"|'|\s|$)/g,
    ];
    for (const regex of patterns) {
      const match = regex.exec(html);
      if (match && match[1]) {
        const username = match[1].toLowerCase();
        // Skip generic Twitter pages
        const skip = ['home', 'explore', 'search', 'intent', 'share', 'hashtag', 'i', 'settings', 'notifications', 'messages'];
        if (!skip.includes(username)) {
          return `https://x.com/${match[1]}`;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Process a Noice (Doppler) deploy — IPFS metadata + optional website scrape for X links
async function processNoiceTx(tx, ipfsCid, t0, blockTimestamp) {
  try {
    const tFetch = performance.now();

    // PARALLEL: receipt + IPFS at the same time
    const [receipt, ipfsResult] = await Promise.all([
      provider.send('eth_getTransactionReceipt', [tx.hash]),
      fetchIpfsMetadata(ipfsCid).catch(() => null)
    ]);

    const tDone = performance.now();
    const createdToken = extractTokenAddress(receipt);

    if (!createdToken) {
      console.log('⚠️ [Noice] No token address in logs. Skipping.');
      return;
    }

    const name = ipfsResult?.data?.name || 'Unknown';
    const symbol = ipfsResult?.data?.symbol || '???';
    const noiceUrl = ipfsResult?.data?.noice || null;
    const websiteRaw = ipfsResult?.data?.website || null;
    const imageIpfs = ipfsResult?.data?.image || null;
    const gatewayBase = ipfsResult?.gatewayBase || 'https://ipfs.io/ipfs/';
    const imageUrl = imageIpfs ? imageIpfs.replace('ipfs://', gatewayBase) : null;

    console.log(`🎵 [Noice] ${name} ($${symbol}) — ${createdToken}`);
    console.log(`   IPFS:   ipfs://${ipfsCid}`);
    console.log(`   Tx:     https://basescan.org/tx/${tx.hash}`);
    if (noiceUrl) console.log(`   Noice:  ${noiceUrl}`);
    if (websiteRaw) console.log(`   Website: ${websiteRaw}`);
    console.log(`   ⏱️  Receipt+IPFS: ${(tDone - tFetch).toFixed(0)}ms`);

    // Broadcast immediately with IPFS data, then enrich with Noice API in background
    let twitterLink = null;
    const socialLinks = [];
    if (websiteRaw) {
      const websiteUrl = websiteRaw.startsWith('http') ? websiteRaw : `https://${websiteRaw}`;
      socialLinks.push({ name: 'website', link: websiteUrl });
    }
    if (noiceUrl) socialLinks.push({ name: 'noice', link: noiceUrl });

    // First broadcast: immediate (no API delay)
    broadcastToken({
      contract_address: createdToken,
      name,
      symbol,
      ipfs_cid: ipfsCid,
      tx_hash: tx.hash,
      created_at: blockTimestamp,
      creator_address: tx.from,
      image_url: imageUrl,
      description: null,
      twitter_link: null,
      website_link: websiteRaw ? (websiteRaw.startsWith('http') ? websiteRaw : `https://${websiteRaw}`) : null,
      noice_url: noiceUrl,
      factory_type: 'noice',
      socialLinks,
      social_context: {
        interface: 'Noice',
        platform: 'Noice',
        messageId: noiceUrl || '',
      },
    });

    console.log(`✅ [Noice] ${name} ($${symbol}) — ${(performance.now() - t0).toFixed(0)}ms total (initial broadcast)`);

    // Background: scrape Noice project page for builder X handles (API is 429-blocked)
    if (noiceUrl) {
      setTimeout(async () => {
        try {
          console.log(`   [Noice Scrape] Scraping ${noiceUrl} for X links...`);
          twitterLink = await scrapeForTwitter(noiceUrl);
          if (twitterLink) {
            console.log(`   🔗 [Noice Scrape] Found X: ${twitterLink}`);
            const enrichedLinks = [...socialLinks];
            if (!enrichedLinks.some(l => l.link === twitterLink)) {
              enrichedLinks.push({ name: 'x', link: twitterLink });
            }
            const buffered = recentTokens.find(t => t.contract_address.toLowerCase() === createdToken.toLowerCase());
            if (buffered) {
              buffered.twitter_link = twitterLink;
              buffered.socialLinks = enrichedLinks;
              buffered.social_context = {
                interface: 'Noice',
                platform: 'X',
                messageId: twitterLink,
              };
              const msg = JSON.stringify({ type: 'update', token: buffered });
              for (const ws of wsClients) {
                if (ws.readyState === 1) ws.send(msg);
              }
              console.log(`   ✅ [Noice Scrape] Enriched ${symbol} with X link, re-broadcast to ${wsClients.size} clients`);
            }
          } else {
            console.log(`   ⚠️ [Noice Scrape] No X link found on project page`);
          }
        } catch (e) {
          console.log(`   ⚠️ [Noice Scrape] Failed: ${e.message}`);
        }
      }, 2000); // 2s delay for page to be ready
    }

    console.log('\x1b[36m%s\x1b[0m', '----------------------------------------');
  } catch (e) {
    console.error('[Noice] Error processing tx:', e.message);
  }
}

async function startListener() {
  try {
    const currentUrl = WSS_URLS[currentUrlIndex];
    console.log('Starting Aggressive BankrFindr + Clanker AI + Virtuals + Noice Monitor...');
    console.log(`WSS URL: ${currentUrl}`);

    provider = new ethers.WebSocketProvider(currentUrl);

    provider.on('block', async (blockNumber) => {
      const t0 = performance.now();
      try {
        const block = await provider.send('eth_getBlockByNumber', [
          ethers.toQuantity(blockNumber),
          true
        ]);

        if (!block || !block.transactions) return;
        const tBlock = performance.now();

        // Use actual block timestamp for created_at (not server time which adds pipeline delay)
        const blockTimestamp = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();

        // Find Bankr matches (calldata), Clanker AI matches (tx.to), Virtuals matches (tx.to), Noice matches (tx.from)
        const bankrMatches = [];
        const clankerAiTxs = [];
        const virtualsTxs = [];
        const noiceTxs = [];
        for (const tx of block.transactions) {
          const data = tx.input || tx.data || '';
          const from = tx.from ? tx.from.toLowerCase() : '';
          // Bankr: match calldata selector + IPFS prefix (but NOT from Noice deployer)
          if (data.includes(TARGET_SELECTOR) && data.includes(IPFS_PREFIX_HEX) && from !== NOICE_DEPLOYER) {
            const ipfsCid = extractIpfsCid(data);
            if (ipfsCid) bankrMatches.push({ tx, data, ipfsCid });
          }
          // Clanker AI: match tx.to === factory address
          if (tx.to && tx.to.toLowerCase() === CLANKER_AI_FACTORY) {
            clankerAiTxs.push(tx);
          }
          // Virtuals: match tx.to === factory + PreLaunch selector (0x5421575e)
          if (tx.to && tx.to.toLowerCase() === VIRTUALS_FACTORY && data.startsWith('0x5421575e')) {
            virtualsTxs.push(tx);
          }
          // Noice: match tx.from === deployer smart account + IPFS in calldata
          if (from === NOICE_DEPLOYER && data.includes(IPFS_PREFIX_HEX)) {
            const ipfsCid = extractIpfsCid(data);
            if (ipfsCid) noiceTxs.push({ tx, ipfsCid });
          }
        }

        if (bankrMatches.length === 0 && clankerAiTxs.length === 0 && virtualsTxs.length === 0 && noiceTxs.length === 0) return;

        const totalMatches = bankrMatches.length + clankerAiTxs.length + virtualsTxs.length + noiceTxs.length;
        console.log(`\n⚡ Block ${blockNumber}: ${totalMatches} deploy(s) found [Bankr: ${bankrMatches.length}, Clanker: ${clankerAiTxs.length}, Virtuals: ${virtualsTxs.length}, Noice: ${noiceTxs.length}] (block fetch: ${(tBlock - t0).toFixed(0)}ms)`);

        // Process all matching txs in parallel
        const allPromises = [];

        // Clanker AI txs — fetch receipt then parse event
        for (const tx of clankerAiTxs) {
          allPromises.push(
            provider.send('eth_getTransactionReceipt', [tx.hash])
              .then(receipt => processClankerAiTx(tx, receipt, t0, blockTimestamp))
              .catch(e => console.error('[Clanker AI] Receipt fetch failed:', e.message))
          );
        }

        // Virtuals txs — fetch receipt then query API for socials
        for (const tx of virtualsTxs) {
          allPromises.push(
            provider.send('eth_getTransactionReceipt', [tx.hash])
              .then(receipt => processVirtualsTx(tx, receipt, t0, blockTimestamp))
              .catch(e => console.error('[Virtuals] Receipt fetch failed:', e.message))
          );
        }

        // Noice txs — IPFS metadata + website scrape for X links
        for (const { tx, ipfsCid } of noiceTxs) {
          allPromises.push(
            processNoiceTx(tx, ipfsCid, t0, blockTimestamp)
              .catch(e => console.error('[Noice] Processing failed:', e.message))
          );
        }

        // Bankr txs — existing logic
        allPromises.push(...bankrMatches.map(async ({ tx, data, ipfsCid }) => {
          try {
            const tFetch = performance.now();

            // PARALLEL: receipt + IPFS at the same time
            const [receipt, ipfsResult] = await Promise.all([
              provider.send('eth_getTransactionReceipt', [tx.hash]),
              fetchIpfsMetadata(ipfsCid).catch(() => null)
            ]);

            const tDone = performance.now();
            const createdToken = extractTokenAddress(receipt);

            if (!createdToken) {
              console.log('⚠️ No token address in logs. Skipping.');
              return;
            }

            console.log(`Token:  ${createdToken}`);
            console.log(`IPFS:   ipfs://${ipfsCid}`);
            console.log(`Tx:     https://basescan.org/tx/${tx.hash}`);
            console.log(`⏱️  Receipt+IPFS parallel: ${(tDone - tFetch).toFixed(0)}ms | Total from block: ${(tDone - t0).toFixed(0)}ms`);


            if (ipfsResult) {
              const { data: ipfsData, gatewayBase } = ipfsResult;
              const tweetUrl = ipfsData.tweet_url || '';
              const isValidTweet = tweetUrl.includes('twitter.com') || tweetUrl.includes('x.com');

              if (!isValidTweet) {
                console.log(`⚠️ Skipping (no valid tweet URL): ${createdToken}`);
                console.log('\x1b[35m%s\x1b[0m', '----------------------------------------');
                return;
              }

              const imageUrl = ipfsData.image
                ? ipfsData.image.replace('ipfs://', gatewayBase)
                : null;

              broadcastToken({
                contract_address: createdToken,
                name: ipfsData.name || "Unknown",
                symbol: ipfsData.symbol || "???",
                ipfs_cid: ipfsCid,
                tx_hash: tx.hash,
                created_at: blockTimestamp,
                creator_address: tx.from,
                image_url: imageUrl,
                description: ipfsData.description || null,
                twitter_link: tweetUrl,
                factory_type: "bankr",
                social_context: {
                  interface: "Bankr",
                  platform: "X",
                  messageId: tweetUrl
                }
              });
              console.log(`✅ ${ipfsData.name} ($${ipfsData.symbol}) — ${(performance.now() - t0).toFixed(0)}ms total`);
            } else {
              console.error(`⚠️ IPFS fetch failed for ${ipfsCid}`);
              broadcastToken({
                contract_address: createdToken,
                name: "Loading...",
                symbol: "...",
                ipfs_cid: ipfsCid,
                tx_hash: tx.hash,
                created_at: blockTimestamp,
                creator_address: tx.from,
                image_url: null,
                description: null,
                twitter_link: null,
                factory_type: "bankr",
              });
            }
            console.log('\x1b[35m%s\x1b[0m', '----------------------------------------');
          } catch (e) {
            console.error('Error processing tx:', e.message);
          }
        }));

        await Promise.all(allPromises);
      } catch (error) {
        console.error(`Error processing block ${blockNumber}:`, error.message);
      }
    });

    provider.websocket.on('error', (err) => {
      console.error('WebSocket Error:', err.message);
    });

    provider.websocket.on('close', () => {
      console.log('WebSocket Connection Closed. Reconnecting...');
      reconnect();
    });

    console.log('✅ Connected to RPC');

  } catch (error) {
    console.error('Error starting listener:', error.message);
    reconnect();
  }
}

async function reconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    if (WSS_URLS.length > 1 && currentUrlIndex < WSS_URLS.length - 1) {
      currentUrlIndex++;
      reconnectAttempts = 0;
      console.log(`⚠️  Switching to backup RPC: ${WSS_URLS[currentUrlIndex]}`);
      setTimeout(startListener, 2000);
      return;
    }

    // Cycle back to 0
    if (currentUrlIndex > 0) {
      currentUrlIndex = 0;
      reconnectAttempts = 0;
      console.log(`🔄 Cycling back to primary RPC: ${WSS_URLS[0]}`);
      setTimeout(startListener, 5000);
      return;
    }

    console.error('❌ All RPC endpoints failed or max retries reached. Retrying primary in 30s...');
    setTimeout(() => {
      reconnectAttempts = 0;
      startListener();
    }, 30000);
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  console.log(`Reconnecting in ${delay / 1000} seconds... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  setTimeout(startListener, delay);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  if (provider) provider.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
  if (provider) provider.destroy();
  process.exit(0);
});

// Validate environment variables
if (WSS_URLS.length === 0) {
  console.error('❌ WSS_URL environment variable is required');
  process.exit(1);
}

console.log(`📡 Configured ${WSS_URLS.length} RPC endpoint(s):`);
WSS_URLS.forEach((url, i) => {
  console.log(`   ${i === 0 ? 'Primary' : 'Backup'}: ${url}`);
});

console.log('🎯 Bankr + Clanker AI + Virtuals + Noice Token Scanner Starting...\n');
startListener();
