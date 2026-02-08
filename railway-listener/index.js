require('dotenv').config();
const { ethers } = require('ethers');
const fetch = require('node-fetch');

// Environment variables
const WSS_URLS = [
  process.env.WSS_URL,           // Primary RPC
  process.env.WSS_URL_BACKUP     // Backup RPC (optional)
].filter(Boolean); // Remove undefined/null entries

const CLANKER_FACTORY = process.env.CLANKER_FACTORY; // Clanker factory contract address
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY; // Neynar API for Farcaster verification

// Upstash Redis (direct write, skips Vercel webhook hop)
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = "clanker:tokens";
const MAX_TOKENS = 100;

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

// ---- Prefetch Cache for pending transactions ----
const pendingTxCache = new Map(); // Map<txHash, { parsedData, timestamp }>
const PENDING_TX_TTL_MS = 60_000; // 60 seconds

// ---- Neynar FID Cache ----
const neynarCache = new Map(); // Map<FID, { hasLinkedX, xUsername, timestamp }>
const NEYNAR_CACHE_TTL_MS = 3600_000; // 1 hour

function cleanupCaches() {
  const now = Date.now();
  for (const [hash, entry] of pendingTxCache) {
    if (now - entry.timestamp > PENDING_TX_TTL_MS) pendingTxCache.delete(hash);
  }
  for (const [fid, entry] of neynarCache) {
    if (now - entry.timestamp > NEYNAR_CACHE_TTL_MS) neynarCache.delete(fid);
  }
}
setInterval(cleanupCaches, 30_000);

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

// Upstash Redis REST helper
async function redisCommand(command) {
  const res = await fetch(`${UPSTASH_REDIS_REST_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return res.json();
}

async function postToRedis(tokenData) {
  try {
    tokenData.received_at = new Date().toISOString();

    // Get existing tokens
    const existing = await redisCommand(["GET", REDIS_KEY]);
    const tokens = existing.result ? JSON.parse(existing.result) : [];

    // Prepend new token, trim to max
    tokens.unshift(tokenData);
    if (tokens.length > MAX_TOKENS) tokens.length = MAX_TOKENS;

    // Write back
    await redisCommand(["SET", REDIS_KEY, JSON.stringify(tokens)]);

    console.log(`✅ ${tokenData.symbol} → Redis direct (${tokens.length} total)`);
  } catch (error) {
    console.error('❌ Redis write failed:', error.message);
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

// Check prefetch cache first, fallback to RPC
async function parseTransactionData(txHash) {
  const cached = pendingTxCache.get(txHash);
  if (cached) {
    console.log(`   [CACHE HIT] Prefetched data for ${txHash.slice(0, 10)}...`);
    pendingTxCache.delete(txHash);
    return cached.parsedData;
  }

  console.log(`   [CACHE MISS] Fetching tx data for ${txHash.slice(0, 10)}...`);
  try {
    const tx = await provider.getTransaction(txHash);
    return parseCalldataFromTx(tx);
  } catch (error) {
    console.error('Error parsing transaction data:', error.message);
    return null;
  }
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
  console.log('\n🚀 NEW TOKEN DETECTED!');
  console.log(`Address: ${tokenAddress}`);
  console.log(`Name: ${name}`);
  console.log(`Symbol: ${symbol}`);
  console.log(`Tx: ${txHash}`);
  console.log(`Block: ${event.blockNumber}`);

  // Parse transaction data to get social context and deployer address
  const txData = await parseTransactionData(txHash);

  if (!txData) {
    console.log('⚠️  Could not parse transaction data, skipping');
    return;
  }

  // Check if deployer is whitelisted
  if (!txData.deployer || !WHITELISTED_DEPLOYERS.has(txData.deployer)) {
    console.log(`⚠️  Deployer ${txData.deployer || 'unknown'} not whitelisted, skipping scam`);
    return;
  }

  console.log(`✅ Found deploy from whitelisted deployer: ${txData.deployer}`);

  // Determine platform: Twitter or Farcaster
  const hasTwitter = !!txData.tweetUrl;
  const hasFarcasterFid = !!txData.id && /^\d+$/.test(txData.id); // FID is numeric

  if (hasTwitter) {
    // Twitter/X deploy - proceed immediately
    console.log(`   Platform: X/Twitter`);
    console.log(`   Tweet: ${txData.tweetUrl}`);
    console.log(`   Image: ${txData.imageUrl || 'N/A'}`);
  } else if (hasFarcasterFid) {
    // Farcaster deploy - verify X account linkage
    console.log(`   Platform: Farcaster`);
    console.log(`   FID: ${txData.id}`);
    console.log(`   Cast: ${txData.messageId || 'N/A'}`);

    // Check if FID is blacklisted
    if (BLACKLISTED_FARCASTER_FIDS.has(txData.id)) {
      console.log(`🚫 Farcaster FID ${txData.id} is blacklisted - skipping`);
      return;
    }

    // Check if FID is whitelisted (bypass X account requirement)
    if (WHITELISTED_FARCASTER_FIDS.has(txData.id)) {
      console.log(`✅ Farcaster FID ${txData.id} is whitelisted - proceeding without X verification`);
    } else {
      const xVerification = await checkFarcasterUserHasX(txData.id);

      if (!xVerification.hasLinkedX) {
        console.log('⚠️  Farcaster user has NO linked X account, skipping');
        return;
      }

      console.log(`✅ Farcaster user has linked X account (@${xVerification.xUsername}) - proceeding`);
      txData.xUsername = xVerification.xUsername; // Add X username to txData
    }
  } else {
    console.log('⚠️  No Twitter URL or Farcaster FID found, skipping');
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
    created_at: new Date().toISOString(),
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

  // Post to webhook immediately
  await postToRedis(tokenData);
}

// Pending transaction prefetch listener
function startPendingTxListener() {
  console.log('⚡ Starting pending tx prefetch listener...');

  provider.on("pending", async (txHash) => {
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx || !tx.to || tx.to.toLowerCase() !== CLANKER_FACTORY.toLowerCase()) return;

      console.log(`\n⚡ [PENDING] Clanker factory tx: ${txHash.slice(0, 10)}...`);

      const parsedData = parseCalldataFromTx(tx);
      if (!parsedData) return;

      // Quick whitelist check - no point caching non-whitelisted
      if (!parsedData.deployer || !WHITELISTED_DEPLOYERS.has(parsedData.deployer)) return;

      console.log(`⚡ [PENDING] Whitelisted deployer. Caching: ${parsedData.name || 'unknown'}`);

      // Pre-fire Neynar check for Farcaster deploys
      const hasFarcasterFid = !!parsedData.id && /^\d+$/.test(parsedData.id);
      if (hasFarcasterFid && !WHITELISTED_FARCASTER_FIDS.has(parsedData.id) && !BLACKLISTED_FARCASTER_FIDS.has(parsedData.id)) {
        console.log(`⚡ [PENDING] Pre-fetching Neynar for FID ${parsedData.id}...`);
        checkFarcasterUserHasX(parsedData.id).catch(() => {});
      }

      // Store in prefetch cache
      pendingTxCache.set(txHash, { parsedData, timestamp: Date.now() });
    } catch {
      // Silently ignore - most pending txs aren't for us
    }
  });

  console.log('⚡ Pending tx prefetch listener active\n');
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
      console.log('\n🚀 NEW EVENT DETECTED!');
      console.log('Block:', log.blockNumber);
      console.log('Tx:', log.transactionHash);

      try {
        if (log.topics.length < 2) {
          console.log('⚠️  Event has no topics, skipping');
          return;
        }

        const tokenAddress = '0x' + log.topics[1].slice(26);
        console.log('Token address:', tokenAddress);

        // Optimization A: Decode name/symbol from log.data (no RPC calls)
        let name, symbol;
        try {
          const abiCoder = ethers.AbiCoder.defaultAbiCoder();
          const decoded = abiCoder.decode(["string", "string"], log.data);
          name = decoded[0];
          symbol = decoded[1];
          console.log(`   [ABI DECODE] name="${name}" symbol="${symbol}" (0ms)`);
        } catch (decodeErr) {
          // Fallback to RPC if ABI decode fails
          console.log(`   [ABI DECODE FAILED] Falling back to RPC: ${decodeErr.message}`);
          const tokenContract = new ethers.Contract(
            tokenAddress,
            ['function name() view returns (string)', 'function symbol() view returns (string)'],
            provider
          );
          [name, symbol] = await Promise.all([
            tokenContract.name(),
            tokenContract.symbol()
          ]);
        }

        console.log('Token name:', name);
        console.log('Token symbol:', symbol);

        await handleTokenCreated(tokenAddress, name, symbol, log.transactionHash, { blockNumber: log.blockNumber });

        console.log(`   [TIMING] Total: ${Date.now() - eventStart}ms`);
      } catch (error) {
        console.error('❌ Error processing event:', error.message);
      }
    });

    // Start pending tx prefetch listener
    startPendingTxListener();

    console.log('👂 Listening for ALL events from factory...\n');

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
  console.log(`   Cache stats: pendingTx=${pendingTxCache.size}, neynar=${neynarCache.size}`);
  if (provider) {
    provider.destroy();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
  console.log(`   Cache stats: pendingTx=${pendingTxCache.size}, neynar=${neynarCache.size}`);
  if (provider) {
    provider.destroy();
  }
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

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error('❌ UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
  process.exit(1);
}

// Start the listener
console.log('🎯 Clanker Token Listener Starting...\n');
startListener();
