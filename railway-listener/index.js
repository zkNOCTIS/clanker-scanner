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

async function handleTokenCreated(tokenAddress, name, symbol, creator, event) {
  console.log('\n🚀 NEW TOKEN DETECTED!');
  console.log(`Address: ${tokenAddress}`);
  console.log(`Name: ${name}`);
  console.log(`Symbol: ${symbol}`);
  console.log(`Creator: ${creator}`);
  console.log(`Block: ${event.blockNumber}`);

  // Try to fetch full token data from Clanker API with retries
  let tokenData = null;
  let attempts = 0;
  const maxAttempts = 5;

  while (!tokenData && attempts < maxAttempts) {
    tokenData = await fetchTokenDataFromClanker(tokenAddress);

    if (!tokenData) {
      attempts++;
      console.log(`Retry ${attempts}/${maxAttempts} in 2 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  if (tokenData) {
    // Post complete token data to webhook
    await postToWebhook(tokenData);
  } else {
    console.log(`⚠️  Could not fetch complete data for ${tokenAddress}, skipping`);
  }
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

    contract = new ethers.Contract(CLANKER_FACTORY, FACTORY_ABI, provider);

    // Listen for TokenCreated events
    contract.on('TokenCreated', handleTokenCreated);

    console.log('👂 Listening for new token deployments...\n');

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
