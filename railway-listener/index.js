require('dotenv').config();
const { ethers } = require('ethers');
const http = require('http');
const { WebSocketServer } = require('ws');

// Environment variables
const WSS_URLS = [
  process.env.WSS_URL,           // Primary RPC
  process.env.WSS_URL_BACKUP     // Backup RPC (optional)
].filter(Boolean); // Remove undefined/null entries

// Whetstone factory (Bankr deploys)
const WHETSTONE_FACTORY = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';
const WHETSTONE_TOPIC = '0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67';

// ERC-4337 EntryPoint — legitimate Bankr deploys go through this
// Terminal scammers call whetstone factory directly, bypassing EntryPoint
const ENTRYPOINT_ADDRESS = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

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
    console.log(`[WS] Skipping duplicate ${tokenData.symbol} (${ca.slice(0,10)}...)`);
    return;
  }
  seenContracts.add(ca);

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

let currentUrlIndex = 0;
let provider;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

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

  // Extract image from IPFS
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

  // Only allow Bankr interface
  const iface = (parsed.interface || '').toLowerCase();
  if (iface !== 'bankr') {
    console.log(`   ⚠️  Interface "${parsed.interface || 'none'}" not Bankr, skipping`);
    return;
  }

  // Verify tx goes through ERC-4337 EntryPoint (blocks terminal scammers)
  try {
    const tx = await provider.getTransaction(log.transactionHash);
    if (!tx || tx.to?.toLowerCase() !== ENTRYPOINT_ADDRESS.toLowerCase()) {
      console.log(`   🚫 Terminal deploy blocked — tx.to: ${tx?.to?.slice(0,10) || 'null'}... (not EntryPoint)`);
      return;
    }
  } catch (err) {
    console.error(`   ⚠️  EntryPoint check failed: ${err.message}, allowing token`);
    // On RPC error, let the token through rather than blocking legit deploys
  }

  const serverNow = new Date().toISOString();
  const hasTwitter = !!parsed.tweetUrl;

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
    farcaster_link: null,
    cast_hash: null,
    website_link: null,
    telegram_link: null,
    discord_link: null,
    social_context: {
      interface: 'Bankr',
      platform: hasTwitter ? 'X' : 'farcaster',
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

    const network = await provider.getNetwork();
    console.log(`✅ Connected to network: ${network.name} (chainId: ${network.chainId})`);

    const whetstonFilter = {
      address: WHETSTONE_FACTORY
    };

    console.log(`📡 Listening to Whetstone Factory: ${WHETSTONE_FACTORY}`);

    provider.on(whetstonFilter, async (log) => {
      try {
        if (log.topics[0] !== WHETSTONE_TOPIC) return;
        await handleWhetstonEvent(log);
      } catch (error) {
        console.error('❌ Whetstone event error:', error.message);
      }
    });

    console.log('👂 Listening for Bankr tokens via Whetstone...\n');

    reconnectAttempts = 0;

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
    if (WSS_URLS.length > 1 && currentUrlIndex < WSS_URLS.length - 1) {
      currentUrlIndex++;
      reconnectAttempts = 0;
      console.log(`⚠️  Switching to backup RPC: ${WSS_URLS[currentUrlIndex]}`);
      setTimeout(startListener, 2000);
      return;
    }

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

console.log('🎯 Bankr Token Scanner Starting...\n');
startListener();
