require('dotenv').config();
const { ethers } = require('ethers');
const fetch = require('node-fetch');

// Environment variables
const WSS_URLS = [
  process.env.WSS_URL,           // Primary RPC
  process.env.WSS_URL_BACKUP     // Backup RPC (optional)
].filter(Boolean); // Remove undefined/null entries

const CLANKER_FACTORY = process.env.CLANKER_FACTORY; // Clanker factory contract address
const WEBHOOK_URL = process.env.WEBHOOK_URL; // Your Vercel webhook URL
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-secret-key';
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY; // Neynar API for Farcaster verification

// Whitelist of legitimate deployer addresses (lowercase)
const WHITELISTED_DEPLOYERS = new Set([
  '0x2112b8456ac07c15fa31ddf3bf713e77716ff3f9',
  '0xd9acd656a5f1b519c9e76a2a6092265a74186e58'
]);

// Whitelisted Farcaster FIDs - these users can deploy without linked X account
const WHITELISTED_FARCASTER_FIDS = new Set([
  '886870'  // @bankr (bankrbot)
]);

let currentUrlIndex = 0; // Track which RPC we're using

// Clanker API for fetching social context
const CLANKER_API = 'https://www.clanker.world/api/tokens';

// ABI for TokenCreated event - we'll update this when we know the actual event structure
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

async function postToWebhook(tokenData) {
  try {
    console.log(`Posting token to webhook: ${tokenData.symbol}`);

    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': WEBHOOK_SECRET
      },
      body: JSON.stringify(tokenData)
    });

    if (response.ok) {
      console.log(`✅ Successfully posted ${tokenData.symbol} to webhook`);
    } else {
      console.error(`❌ Webhook POST failed: ${response.status}`);
    }
  } catch (error) {
    console.error('Error posting to webhook:', error.message);
  }
}

async function parseTransactionData(txHash) {
  try {
    console.log(`Fetching transaction data for ${txHash}...`);
    const tx = await provider.getTransaction(txHash);

    if (!tx || !tx.data) {
      console.log('No transaction data found');
      return null;
    }

    // Get deployer address for whitelist verification
    const deployer = tx.from?.toLowerCase() || null;

    // Decode the input data - looking for JSON strings in the hex data
    const hexData = tx.data;

    // Convert hex to ASCII and look for JSON patterns
    let asciiData = '';
    for (let i = 2; i < hexData.length; i += 2) {
      const byte = parseInt(hexData.substr(i, 2), 16);
      if (byte >= 32 && byte <= 126) { // Printable ASCII
        asciiData += String.fromCharCode(byte);
      } else {
        asciiData += ' ';
      }
    }

    // Extract tweet URL from context.messageId (both twitter.com and x.com)
    const tweetMatch = asciiData.match(/https:\/\/(twitter\.com|x\.com)\/[^"\s]+\/status\/\d+/);
    const imageMatch = asciiData.match(/https:\/\/pbs\.twimg\.com\/media\/[^\s"]+/);
    const nameMatch = asciiData.match(/"name":"([^"]+)"/);
    const symbolMatch = asciiData.match(/"symbol":"([^"]+)"/);
    const descMatch = asciiData.match(/"description":"([^"]+)"/);

    // Extract social_context fields (for Bankr verification)
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
      // Social context for Bankr verification
      interface: interfaceMatch ? interfaceMatch[1] : null,
      platform: platformMatch ? platformMatch[1] : null,
      messageId: messageIdMatch ? messageIdMatch[1] : null,
      id: idMatch ? idMatch[1] : null,
      // Deployer address for whitelist verification
      deployer: deployer
    };
  } catch (error) {
    console.error('Error parsing transaction data:', error.message);
    return null;
  }
}

// Note: Twitter stats extraction moved to frontend where we can parse the embedded tweet HTML

async function checkFarcasterUserHasX(fid) {
  if (!NEYNAR_API_KEY || NEYNAR_API_KEY === 'your_neynar_api_key_here') {
    console.log('⚠️  Neynar API key not configured, skipping Farcaster verification');
    return false;
  }

  try {
    console.log(`Checking Farcaster FID ${fid} for linked X account...`);

    // Neynar API v2 endpoint for user details
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
      return false;
    }

    const user = data.users[0];

    // Check if user has verified X account in verified_accounts
    const verifiedXAccount = user.verified_accounts?.find(acc => acc.platform === 'x');

    if (verifiedXAccount && verifiedXAccount.username) {
      console.log(`✅ Farcaster user ${fid} (@${user.username}) has linked X account: @${verifiedXAccount.username}`);
      return { hasLinkedX: true, xUsername: verifiedXAccount.username };
    }

    console.log(`❌ Farcaster user ${fid} (@${user.username}) has NO linked X account`);
    return { hasLinkedX: false, xUsername: null };
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
  // For Farcaster deploys, messageId contains the cast hash (starts with 0x)
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
    twitter_link: hasTwitter ? txData.tweetUrl : null,
    farcaster_link: hasFarcasterFid ? txData.messageId : null,
    cast_hash: castHash, // Cast hash for Farcaster deploys
    website_link: null,
    telegram_link: null,
    discord_link: null,
    // Include social_context for both Twitter and Farcaster
    social_context: {
      interface: txData.interface || (hasTwitter ? 'twitter' : 'farcaster'),
      platform: hasTwitter ? 'X' : 'farcaster',
      messageId: txData.messageId || txData.tweetUrl || '',
      id: txData.id || '',
      xUsername: txData.xUsername || null // X username for verified Farcaster users
    }
  };

  // Post to webhook immediately
  await postToWebhook(tokenData);
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

    // Listen to ALL events from factory (to debug the actual event structure)
    const filter = {
      address: CLANKER_FACTORY
    };

    // Create contract interface to decode events
    contract = new ethers.Contract(CLANKER_FACTORY, FACTORY_ABI, provider);

    provider.on(filter, async (log) => {
      console.log('\n🚀 NEW EVENT DETECTED!');
      console.log('Block:', log.blockNumber);
      console.log('Tx:', log.transactionHash);

      try {
        // Extract token address from topics (first indexed parameter)
        if (log.topics.length >= 2) {
          const tokenAddress = '0x' + log.topics[1].slice(26); // Remove padding
          console.log('Token address:', tokenAddress);

          // Call the token contract to get name and symbol
          const tokenContract = new ethers.Contract(
            tokenAddress,
            ['function name() view returns (string)', 'function symbol() view returns (string)'],
            provider
          );

          console.log('Fetching token name and symbol...');
          const [name, symbol] = await Promise.all([
            tokenContract.name(),
            tokenContract.symbol()
          ]);

          console.log('Token name:', name);
          console.log('Token symbol:', symbol);

          // Parse transaction data directly from blockchain
          handleTokenCreated(tokenAddress, name, symbol, log.transactionHash, { blockNumber: log.blockNumber });
        } else {
          console.log('⚠️  Event has no topics, skipping');
        }
      } catch (error) {
        console.error('❌ Error processing event:', error.message);
      }
    });

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
  if (provider) {
    provider.destroy();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
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

if (!WEBHOOK_URL) {
  console.error('❌ WEBHOOK_URL environment variable is required');
  process.exit(1);
}

// Start the listener
console.log('🎯 Clanker Token Listener Starting...\n');
startListener();
