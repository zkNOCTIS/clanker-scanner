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

let currentUrlIndex = 0;
let provider;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Fetch IPFS metadata from multiple gateways (race for fastest)
async function fetchIpfsMetadata(ipfsCid) {
  const gateways = [
    'https://ipfs.io/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/'
  ];

  return Promise.any(
    gateways.map(async (base) => {
      const res = await fetch(`${base}${ipfsCid}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return { data, gatewayBase: base };
    })
  );
}

// Process raw transaction to find IPFS CID and deployed token
async function processRawTransaction(tx, data, receipt) {
  try {
    const hex = data.startsWith('0x') ? data.slice(2) : data;
    const ipfsIdx = hex.indexOf(IPFS_PREFIX_HEX);

    if (ipfsIdx !== -1) {
      let ipfs = "";
      for (let i = ipfsIdx; i < hex.length; i += 2) {
        const byte = parseInt(hex.slice(i, i + 2), 16);
        if (byte >= 32 && byte <= 126) {
          ipfs += String.fromCharCode(byte);
        } else {
          break;
        }
      }

      // Find deployed token address from logs
      let createdToken = "Unknown";
      if (receipt && receipt.logs) {
        const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        const zeroAddressTopic = '0x0000000000000000000000000000000000000000000000000000000000000000';

        for (const log of receipt.logs) {
          if (log.topics[0] === transferTopic && log.topics[1] === zeroAddressTopic) {
            createdToken = log.address;
            break;
          }
        }
      }

      // Verify we found a valid token address
      if (createdToken === "Unknown") {
        console.log('⚠️ Could not find deployed token address in logs. Skipping.');
        console.log('\x1b[35m%s\x1b[0m', '----------------------------------------');
        return;
      }

      console.log(`Token:  ${createdToken}`);
      console.log(`IPFS:   ${ipfs}`);
      console.log(`Tx:     https://basescan.org/tx/${tx.hash}`);

      const ipfsCid = ipfs.replace('ipfs://', '');
      const serverNow = new Date().toISOString();

      // Fetch IPFS metadata on Railway — validates tweet URL before broadcasting
      // This is faster than browser-side fetch because it starts immediately
      try {
        const { data: ipfsData, gatewayBase } = await fetchIpfsMetadata(ipfsCid);
        const tweetUrl = ipfsData.tweet_url || '';
        const isValidTweet = tweetUrl.includes('twitter.com') || tweetUrl.includes('x.com');

        if (!isValidTweet) {
          console.log(`⚠️ Skipping (no valid tweet URL): ${createdToken}`);
          console.log('\x1b[35m%s\x1b[0m', '----------------------------------------');
          return;
        }

        // Build image URL using the winning gateway
        const imageUrl = ipfsData.image
          ? ipfsData.image.replace('ipfs://', gatewayBase)
          : null;

        const tokenData = {
          contract_address: createdToken,
          name: ipfsData.name || "Unknown",
          symbol: ipfsData.symbol || "???",
          ipfs_cid: ipfsCid,
          tx_hash: tx.hash,
          created_at: serverNow,
          creator_address: tx.from,
          image_url: imageUrl,
          description: ipfsData.description || null,
          twitter_link: tweetUrl,
          social_context: {
            interface: "Bankr",
            platform: "X",
            messageId: tweetUrl
          }
        };

        broadcastToken(tokenData);
        console.log(`✅ ${ipfsData.name} ($${ipfsData.symbol}) — tweet validated`);
      } catch (ipfsErr) {
        console.error(`⚠️ IPFS fetch failed for ${ipfsCid}: ${ipfsErr.message || ipfsErr}`);
        // Broadcast partial as fallback — browser can retry IPFS fetch
        const tokenData = {
          contract_address: createdToken,
          name: "Loading...",
          symbol: "...",
          ipfs_cid: ipfsCid,
          tx_hash: tx.hash,
          created_at: serverNow,
          creator_address: tx.from,
          image_url: null,
          description: null,
          twitter_link: null,
        };
        broadcastToken(tokenData);
      }

      console.log('\x1b[35m%s\x1b[0m', '----------------------------------------');
    }
  } catch (e) {
    console.error('Error extraction:', e.message);
  }
}

async function startListener() {
  try {
    const currentUrl = WSS_URLS[currentUrlIndex];
    console.log('Starting Aggressive BankrFindr Monitor...');
    console.log(`WSS URL: ${currentUrl}`);

    provider = new ethers.WebSocketProvider(currentUrl);

    provider.on('block', async (blockNumber) => {
      //console.log(`New block received: ${blockNumber}`);
      try {
        const block = await provider.send('eth_getBlockByNumber', [
          ethers.toBeHex(blockNumber),
          true
        ]);

        if (!block || !block.transactions) return;

        for (const tx of block.transactions) {
          const data = tx.input || tx.data || '';
          if (data.includes(TARGET_SELECTOR) && data.includes(IPFS_PREFIX_HEX)) {
            // Fetch receipt to find created token
            const receipt = await provider.send('eth_getTransactionReceipt', [tx.hash]);
            processRawTransaction(tx, data, receipt);
          }
        }
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

console.log('🎯 Bankr Token Scanner Starting...\n');
startListener();
