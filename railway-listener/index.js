require('dotenv').config();
const { ethers } = require('ethers');
const fetch = require('node-fetch');
const http = require('http');
const { WebSocketServer } = require('ws');

// Environment variables
const WSS_URLS = [
  process.env.WSS_URL,           // Primary RPC
  process.env.WSS_URL_BACKUP     // Backup RPC (optional)
].filter(Boolean); // Remove undefined/null entries

const CLANKER_FACTORY = process.env.CLANKER_FACTORY; // Clanker factory contract address
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY; // Neynar API for Farcaster verification

// Whetstone factory (new unified factory for Bankr + Clanker deploys)
const WHETSTONE_FACTORY = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';
const WHETSTONE_TOPIC = '0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67';

// In-memory token buffer (replaces Redis - WebSocket push means no external store needed)
const recentTokens = []; // Most recent first
const MAX_TOKENS = 50;

// Whitelist of legitimate deployer addresses (lowercase)
const WHITELISTED_DEPLOYERS = new Set([
  '0x2112b8456ac07c15fa31ddf3bf713e77716ff3f9',
  '0xd9acd656a5f1b519c9e76a2a6092265a74186e58'
]);

// Whitelisted Farcaster FIDs - these users can deploy without linked X account
const WHITELISTED_FARCASTER_FIDS = new Set([
  '886870'  // @bankr (bankrbot)
]);

// Blacklisted Farcaster FIDs - block these users from showing on scanner
const BLACKLISTED_FARCASTER_FIDS = new Set([
  '897406'  // @outflow.eth - spam deployer
]);

// ---- Neynar FID Cache ----
const neynarCache = new Map(); // Map<FID, { hasLinkedX, xUsername, timestamp }>
const NEYNAR_CACHE_TTL_MS = 3600_000; // 1 hour

function cleanupCaches() {
  const now = Date.now();
  for (const [fid, entry] of neynarCache) {
    if (now - entry.timestamp > NEYNAR_CACHE_TTL_MS) neynarCache.delete(fid);
  }
}
setInterval(cleanupCaches, 30_000);

// ---- WebSocket Server for direct browser push ----
const WS_PORT = parseInt(process.env.PORT) || 3001;
const server = http.createServer((req, res) => {
  // Health check endpoint
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

  // Send recent tokens from in-memory buffer
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
  // Store in memory buffer
  recentTokens.unshift(tokenData);
  if (recentTokens.length > MAX_TOKENS) recentTokens.length = MAX_TOKENS;

  const msg = JSON.stringify({ type: 'token', token: tokenData });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
  console.log(`[WS] Broadcasted ${tokenData.symbol} to ${wsClients.size} clients (buffer: ${recentTokens.length})`);
}

server.listen(WS_PORT, () => {
  console.log(`🌐 WebSocket server listening on port ${WS_PORT}`);
});

let currentUrlIndex = 0; // Track which RPC we're using

// Clanker API for fetching social context
const CLANKER_API = 'https://www.clanker.world/api/tokens';

// ABI for TokenCreated event
const FACTORY_ABI = [
  "event TokenCreated(address indexed token, string name, string symbol, address indexed creator)"
];

let provider;
let contract;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

async function fetchTokenDataFromClanker(contractAddress) {
  try {
    console.log(`Fetching token data from Clanker API for ${contractAddress}...`);

    // Fetch recent tokens from Clanker API
    const response = await fetch(`${CLANKER_API}?sort=desc&page=0&limit=50`);
    const data = await response.json();

    // Find token by contract address
    const token = data.data?.find(
      t => t.contract_address?.toLowerCase() === contractAddress.toLowerCase()
    );

    if (token) {
      console.log(`Found token data: ${token.symbol} (${token.name})`);
      return token;
    }

    console.log(`Token ${contractAddress} not found in Clanker API yet, will retry...`);
    return null;
  } catch (error) {
    console.error('Error fetching from Clanker API:', error.message);
    return null;
  }
}


// Pure function: parse calldata from a transaction object (no RPC calls)
function parseCalldataFromTx(tx) {
  if (!tx || !tx.data) return null;

  const deployer = tx.from?.toLowerCase() || null;
  const hexData = tx.data;

  // Convert hex to ASCII and look for JSON patterns
  let asciiData = '';
  for (let i = 2; i < hexData.length; i += 2) {
    const byte = parseInt(hexData.substr(i, 2), 16);
    if (byte >= 32 && byte <= 126) {
      asciiData += String.fromCharCode(byte);
    } else {
      asciiData += ' ';
    }
  }

  const tweetMatch = asciiData.match(/https:\/\/(twitter\.com|x\.com)\/[^"\s]+\/status\/\d+/);
  const imageMatch = asciiData.match(/https:\/\/pbs\.twimg\.com\/media\/[^\s"]+/);
  const nameMatch = asciiData.match(/"name":"([^"]+)"/);
  const symbolMatch = asciiData.match(/"symbol":"([^"]+)"/);
  const descMatch = asciiData.match(/"description":"([^"]+)"/);
  const interfaceMatch = asciiData.match(/"interface":"([^"]+)"/);
  const platformMatch = asciiData.match(/"platform":"([^"]+)"/);
  const messageIdMatch = asciiData.match(/"messageId":"([^"]+)"/);
  const idMatch = asciiData.match(/"id":"([^"]+)"/);

  return {
    tweetUrl: tweetMatch ? tweetMatch[0] : null,
    imageUrl: imageMatch ? imageMatch[0] : null,
    name: nameMatch ? nameMatch[1] : null,
    symbol: symbolMatch ? symbolMatch[1] : null,
    description: descMatch ? descMatch[1] : null,
    interface: interfaceMatch ? interfaceMatch[1] : null,
    platform: platformMatch ? platformMatch[1] : null,
    messageId: messageIdMatch ? messageIdMatch[1] : null,
    id: idMatch ? idMatch[1] : null,
    deployer: deployer
  };
}

async function parseTransactionData(txHash) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const tx = await provider.getTransaction(txHash);
      if (tx) return parseCalldataFromTx(tx);
      console.log(`   [RETRY ${attempt + 1}/2] tx null, waiting 30ms...`);
      await new Promise(r => setTimeout(r, 30));
    } catch (error) {
      console.error(`   [RETRY ${attempt + 1}/2] Error: ${error.message}`);
      await new Promise(r => setTimeout(r, 30));
    }
  }
  console.error('   ❌ Failed to fetch tx after 2 attempts');
  return null;
}

// Note: Twitter stats extraction moved to frontend where we can parse the embedded tweet HTML

async function checkFarcasterUserHasX(fid) {
  // Check Neynar cache first
  const cached = neynarCache.get(fid);
  if (cached) {
    console.log(`   [NEYNAR CACHE] FID ${fid}: hasLinkedX=${cached.hasLinkedX}`);
    return { hasLinkedX: cached.hasLinkedX, xUsername: cached.xUsername };
  }

  if (!NEYNAR_API_KEY || NEYNAR_API_KEY === 'your_neynar_api_key_here') {
    console.log('⚠️  Neynar API key not configured, skipping Farcaster verification');
    return false;
  }

  try {
    console.log(`Checking Farcaster FID ${fid} for linked X account...`);

    const response = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`, {
      headers: {
        'accept': 'application/json',
        'api_key': NEYNAR_API_KEY
      }
    });

    if (!response.ok) {
      console.error(`Neynar API error: ${response.status}`);
      return false;
    }

    const data = await response.json();

    if (!data.users || data.users.length === 0) {
      console.log(`Farcaster user ${fid} not found`);
      neynarCache.set(fid, { hasLinkedX: false, xUsername: null, timestamp: Date.now() });
      return false;
    }

    const user = data.users[0];
    const verifiedXAccount = user.verified_accounts?.find(acc => acc.platform === 'x');

    const result = {
      hasLinkedX: !!(verifiedXAccount && verifiedXAccount.username),
      xUsername: verifiedXAccount?.username || null
    };

    // Cache the result
    neynarCache.set(fid, { ...result, timestamp: Date.now() });

    if (result.hasLinkedX) {
      console.log(`✅ Farcaster user ${fid} (@${user.username}) has linked X: @${result.xUsername}`);
    } else {
      console.log(`❌ Farcaster user ${fid} (@${user.username}) has NO linked X account`);
    }

    return result;
  } catch (error) {
    console.error('Error checking Farcaster user:', error.message);
    return false;
  }
}

async function handleTokenCreated(tokenAddress, name, symbol, txHash, event) {
  const t0 = Date.now();
  console.log(`\n🚀 ${symbol} | ${tokenAddress.slice(0,10)}... | Block ${event.blockNumber}`);

  // Use server timestamp — saves ~300-500ms vs getBlock() RPC call
  // On Base L2 (1s blocks), event arrives within ~1-2s of block time, close enough for antibot timer
  const serverNow = new Date().toISOString();

  const txData = await parseTransactionData(txHash);
  const t1 = Date.now();
  console.log(`   ⏱ getTx: ${t1 - t0}ms`);

  if (!txData) {
    console.log('⚠️  Could not parse transaction data, skipping');
    return;
  }

  // Check if deployer is whitelisted
  if (!txData.deployer || !WHITELISTED_DEPLOYERS.has(txData.deployer)) {
    console.log(`⚠️  Deployer ${txData.deployer || 'unknown'} not whitelisted, skipping scam`);
    return;
  }

  // Skip Clank.fun deploys - no useful social context to display
  if (txData.interface && txData.interface.toLowerCase() === 'clank.fun') {
    console.log('⚠️  Clank.fun deploy, skipping (no social context)');
    return;
  }

  // Determine platform: Twitter or Farcaster
  const hasTwitter = !!txData.tweetUrl;
  const hasFarcasterFid = !!txData.id && /^\d+$/.test(txData.id); // FID is numeric

  if (hasTwitter) {
    // Twitter/X deploy - proceed immediately
  } else if (hasFarcasterFid) {

    if (BLACKLISTED_FARCASTER_FIDS.has(txData.id)) return;

    if (WHITELISTED_FARCASTER_FIDS.has(txData.id)) {
      // Whitelisted FID - bypass X check
    } else {
      const neynarStart = Date.now();
      const xVerification = await checkFarcasterUserHasX(txData.id);
      console.log(`   ⏱ neynar: ${Date.now() - neynarStart}ms ${neynarCache.has(txData.id) ? '[CACHED]' : '[API]'}`);
      if (!xVerification.hasLinkedX) return;
      txData.xUsername = xVerification.xUsername;
    }
  } else {
    return;
  }

  // Build token data object matching Clanker API format
  const castHash = hasFarcasterFid && txData.messageId && txData.messageId.startsWith('0x')
    ? txData.messageId
    : null;

  const tokenData = {
    contract_address: tokenAddress,
    name: name,
    symbol: symbol,
    image_url: txData.imageUrl,
    description: txData.description || '',
    tx_hash: txHash,
    created_at: serverNow,
    creator_address: null,
    msg_sender: txData.deployer || null,
    twitter_link: hasTwitter ? txData.tweetUrl : null,
    farcaster_link: hasFarcasterFid ? txData.messageId : null,
    cast_hash: castHash,
    website_link: null,
    telegram_link: null,
    discord_link: null,
    social_context: {
      interface: txData.interface || (hasTwitter ? 'twitter' : hasFarcasterFid ? 'farcaster' : 'unknown'),
      platform: hasTwitter ? 'X' : hasFarcasterFid ? 'farcaster' : (txData.platform || 'unknown'),
      messageId: txData.messageId || txData.tweetUrl || '',
      id: txData.id || '',
      xUsername: txData.xUsername || null
    }
  };

  // Broadcast via WebSocket (stored in memory buffer + pushed to all clients)
  broadcastToken(tokenData);
}

// Parse whetstone factory event data — extracts social context from JSON blocks in event data
function parseWhetstonEventData(log) {
  const tokenAddress = '0x' + log.topics[1].slice(26);
  const creatorAddress = '0x' + log.topics[2].slice(26);

  const hexData = log.data.slice(2);

  // Convert hex to ASCII for JSON extraction
  let ascii = '';
  for (let i = 0; i < hexData.length; i += 2) {
    const byte = parseInt(hexData.substr(i, 2), 16);
    ascii += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : ' ';
  }

  // Extract name/symbol from ABI-encoded strings in event data
  // They appear as: 32-byte length slot + 32-byte data slot
  // Scan for string-length values (1-64) followed by printable ASCII
  let name = '', symbol = '';
  const slotCount = Math.floor(hexData.length / 64);
  for (let i = 10; i < Math.min(slotCount - 1, 25); i++) {
    const lenSlot = hexData.slice(i * 64, (i + 1) * 64);
    const len = parseInt(lenSlot, 16);
    if (len > 0 && len <= 64) {
      const dataHex = hexData.slice((i + 1) * 64, (i + 1) * 64 + len * 2);
      try {
        const str = Buffer.from(dataHex, 'hex').toString('utf8').replace(/\0/g, '');
        if (str.length > 0 && str.length <= len && /^[\x20-\x7e\u0080-\uffff]+$/.test(str)) {
          if (!name) { name = str; }
          else if (!symbol) { symbol = str; break; }
        }
      } catch (e) { /* skip */ }
    }
  }

  // Find JSON blocks via brace matching
  const jsonBlocks = [];
  let depth = 0, start = -1;
  for (let i = 0; i < ascii.length; i++) {
    if (ascii[i] === '{') { if (depth === 0) start = i; depth++; }
    if (ascii[i] === '}') { depth--; if (depth === 0 && start >= 0) { jsonBlocks.push(ascii.slice(start, i + 1)); start = -1; } }
  }

  // Parse JSON blocks for metadata and context
  let metadata = null, context = null;
  for (const block of jsonBlocks) {
    try {
      const parsed = JSON.parse(block);
      if (parsed.interface || parsed.platform || parsed.messageId) {
        context = parsed;
      } else if (parsed.description !== undefined || parsed.socialMediaUrls) {
        metadata = parsed;
      }
    } catch (e) { /* malformed JSON, skip */ }
  }

  // Extract tweet URL from context.messageId
  let tweetUrl = null;
  if (context?.messageId) {
    const tweetMatch = context.messageId.match(/https:\/\/(twitter\.com|x\.com)\/[^"\s]+\/status\/\d+/);
    if (tweetMatch) tweetUrl = tweetMatch[0];
  }

  // Extract image from metadata socialMediaUrls or IPFS
  let imageUrl = null;
  const ipfsMatch = ascii.match(/ipfs:\/\/[a-zA-Z0-9]+/);
  if (ipfsMatch) imageUrl = ipfsMatch[0];

  return {
    tokenAddress,
    creatorAddress,
    name,
    symbol,
    tweetUrl,
    imageUrl,
    description: metadata?.description || '',
    interface: context?.interface || null,
    platform: context?.platform || null,
    messageId: context?.messageId || null,
    id: context?.id || null,
    xUsername: null
  };
}

async function handleWhetstonEvent(log) {
  const t0 = Date.now();
  const parsed = parseWhetstonEventData(log);

  console.log(`\n🔷 [WHETSTONE] ${parsed.symbol || '?'} | ${parsed.tokenAddress.slice(0,10)}... | Block ${log.blockNumber}`);

  // Only allow known legitimate interfaces — reject everything else
  const iface = (parsed.interface || '').toLowerCase();
  if (iface !== 'bankr' && iface !== 'clanker') {
    console.log(`   ⚠️  Unknown interface "${parsed.interface || 'none'}", skipping`);
    return;
  }

  // Must have social context (tweet URL or Farcaster cast)
  if (!parsed.tweetUrl && !parsed.messageId) {
    console.log('   ⚠️  No social context, skipping');
    return;
  }

  const serverNow = new Date().toISOString();
  const hasTwitter = !!parsed.tweetUrl;
  const hasFarcasterFid = !!parsed.id && /^\d+$/.test(parsed.id) && parsed.platform?.toLowerCase() === 'farcaster';

  // For Farcaster tokens, run the same verification as before
  if (!hasTwitter && hasFarcasterFid) {
    if (BLACKLISTED_FARCASTER_FIDS.has(parsed.id)) return;

    if (!WHITELISTED_FARCASTER_FIDS.has(parsed.id)) {
      const neynarStart = Date.now();
      const xVerification = await checkFarcasterUserHasX(parsed.id);
      console.log(`   ⏱ neynar: ${Date.now() - neynarStart}ms ${neynarCache.has(parsed.id) ? '[CACHED]' : '[API]'}`);
      if (!xVerification.hasLinkedX) return;
      parsed.xUsername = xVerification.xUsername;
    }
  } else if (!hasTwitter) {
    // No tweet URL and not a valid Farcaster deploy
    return;
  }

  const castHash = hasFarcasterFid && parsed.messageId && parsed.messageId.startsWith('0x')
    ? parsed.messageId
    : null;

  const tokenData = {
    contract_address: parsed.tokenAddress,
    name: parsed.name,
    symbol: parsed.symbol,
    image_url: parsed.imageUrl,
    description: parsed.description,
    tx_hash: log.transactionHash,
    created_at: serverNow,
    creator_address: parsed.creatorAddress,
    msg_sender: parsed.creatorAddress,
    twitter_link: hasTwitter ? parsed.tweetUrl : null,
    farcaster_link: hasFarcasterFid ? parsed.messageId : null,
    cast_hash: castHash,
    website_link: null,
    telegram_link: null,
    discord_link: null,
    social_context: {
      interface: parsed.interface || (hasTwitter ? 'Bankr' : 'clanker'),
      platform: hasTwitter ? 'X' : hasFarcasterFid ? 'farcaster' : (parsed.platform || 'unknown'),
      messageId: parsed.messageId || parsed.tweetUrl || '',
      id: parsed.id || '',
      xUsername: parsed.xUsername || null
    }
  };

  broadcastToken(tokenData);
  console.log(`   ⏱ ${Date.now() - t0}ms total`);
}

async function startListener() {
  try {
    const currentUrl = WSS_URLS[currentUrlIndex];
    console.log('🔌 Connecting to Base RPC via WebSocket...');
    console.log(`WSS URL: ${currentUrl} (${currentUrlIndex === 0 ? 'Primary' : 'Backup'})`);

    provider = new ethers.WebSocketProvider(currentUrl);

    // Test connection
    const network = await provider.getNetwork();
    console.log(`✅ Connected to network: ${network.name} (chainId: ${network.chainId})`);

    console.log(`📡 Listening to Clanker Factory: ${CLANKER_FACTORY}`);

    const filter = {
      address: CLANKER_FACTORY
    };

    contract = new ethers.Contract(CLANKER_FACTORY, FACTORY_ABI, provider);

    provider.on(filter, async (log) => {
      const eventStart = Date.now();

      try {
        if (log.topics.length < 2) return;

        const tokenAddress = '0x' + log.topics[1].slice(26);

        // ABI decode name/symbol from log.data (no RPC)
        let name, symbol;
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string", "string"], log.data);
          name = decoded[0];
          symbol = decoded[1];
        } catch {
          const tokenContract = new ethers.Contract(
            tokenAddress,
            ['function name() view returns (string)', 'function symbol() view returns (string)'],
            provider
          );
          [name, symbol] = await Promise.all([tokenContract.name(), tokenContract.symbol()]);
        }

        await handleTokenCreated(tokenAddress, name, symbol, log.transactionHash, { blockNumber: log.blockNumber });

        console.log(`   ⏱ ${Date.now() - eventStart}ms total`);
      } catch (error) {
        console.error('❌ Event error:', error.message);
      }
    });

    // Whetstone factory listener (Bankr + new Clanker deploys)
    const whetstonFilter = {
      address: WHETSTONE_FACTORY,
      topics: [WHETSTONE_TOPIC]
    };

    console.log(`📡 Listening to Whetstone Factory: ${WHETSTONE_FACTORY}`);

    provider.on(whetstonFilter, async (log) => {
      try {
        await handleWhetstonEvent(log);
      } catch (error) {
        console.error('❌ Whetstone event error:', error.message);
      }
    });

    console.log('👂 Listening for events from both factories...\n');

    // Reset reconnect attempts on successful connection
    reconnectAttempts = 0;

    // Handle WebSocket errors
    provider.websocket.on('error', (error) => {
      console.error('WebSocket error:', error.message);
    });

    provider.websocket.on('close', () => {
      console.log('WebSocket connection closed, attempting to reconnect...');
      reconnect();
    });

  } catch (error) {
    console.error('Error starting listener:', error.message);
    reconnect();
  }
}

async function reconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    // Try switching to backup RPC if available
    if (WSS_URLS.length > 1 && currentUrlIndex < WSS_URLS.length - 1) {
      currentUrlIndex++;
      reconnectAttempts = 0; // Reset attempts for new URL
      console.log(`⚠️  Switching to backup RPC: ${WSS_URLS[currentUrlIndex]}`);
      setTimeout(startListener, 2000);
      return;
    }

    // If we've tried all URLs, go back to primary and keep trying
    if (currentUrlIndex > 0) {
      currentUrlIndex = 0;
      reconnectAttempts = 0;
      console.log(`🔄 Cycling back to primary RPC: ${WSS_URLS[0]}`);
      setTimeout(startListener, 5000);
      return;
    }

    console.error('❌ All RPC endpoints failed. Exiting...');
    process.exit(1);
  }

  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  console.log(`Reconnecting in ${delay/1000} seconds... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  setTimeout(startListener, delay);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  console.log(`   Cache stats: neynar=${neynarCache.size}`);
  if (provider) provider.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
  console.log(`   Cache stats: neynar=${neynarCache.size}`);
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

if (!CLANKER_FACTORY) {
  console.error('❌ CLANKER_FACTORY environment variable is required');
  process.exit(1);
}

// Start the listener
console.log('🎯 Clanker Token Listener Starting...\n');
startListener();
