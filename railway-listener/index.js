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

async function parseTransactionData(txHash) {
  try {
    console.log(`Fetching transaction data for ${txHash}...`);
    const tx = await provider.getTransaction(txHash);

    if (!tx || !tx.data) {
      console.log('No transaction data found');
      return null;
    }

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

    // Extract tweet URL from context.messageId
    const tweetMatch = asciiData.match(/https:\/\/twitter\.com\/[^"\s]+\/status\/\d+/);
    const imageMatch = asciiData.match(/https:\/\/pbs\.twimg\.com\/media\/[^\s"]+/);
    const nameMatch = asciiData.match(/"name":"([^"]+)"/);
    const symbolMatch = asciiData.match(/"symbol":"([^"]+)"/);
    const descMatch = asciiData.match(/"description":"([^"]+)"/);

    return {
      tweetUrl: tweetMatch ? tweetMatch[0] : null,
      imageUrl: imageMatch ? imageMatch[0] : null,
      name: nameMatch ? nameMatch[1] : null,
      symbol: symbolMatch ? symbolMatch[1] : null,
      description: descMatch ? descMatch[1] : null
    };
  } catch (error) {
    console.error('Error parsing transaction data:', error.message);
    return null;
  }
}

async function handleTokenCreated(tokenAddress, name, symbol, txHash, event) {
  console.log('\n🚀 NEW TOKEN DETECTED!');
  console.log(`Address: ${tokenAddress}`);
  console.log(`Name: ${name}`);
  console.log(`Symbol: ${symbol}`);
  console.log(`Tx: ${txHash}`);
  console.log(`Block: ${event.blockNumber}`);

  // Parse transaction data to get tweet URL and image
  const txData = await parseTransactionData(txHash);

  if (!txData || !txData.tweetUrl) {
    console.log('⚠️  Could not extract tweet URL from transaction, skipping');
    return;
  }

  console.log(`✅ Found tweet: ${txData.tweetUrl}`);
  console.log(`   Image: ${txData.imageUrl || 'N/A'}`);

  // Build token data object matching Clanker API format
  const tokenData = {
    contract_address: tokenAddress,
    name: name,
    symbol: symbol,
    image_url: txData.imageUrl,
    description: txData.description || '',
    tx_hash: txHash,
    created_at: new Date().toISOString(),
    creator_address: null,
    twitter_link: txData.tweetUrl,
    farcaster_link: null,
    website_link: null,
    telegram_link: null,
    discord_link: null
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
        // Decode the event using the ABI
        const parsedLog = contract.interface.parseLog({
          topics: log.topics,
          data: log.data
        });

        if (parsedLog) {
          const tokenAddress = parsedLog.args.token;
          const name = parsedLog.args.name;
          const symbol = parsedLog.args.symbol;
          const creator = parsedLog.args.creator;

          console.log('Decoded event:');
          console.log('  Token:', tokenAddress);
          console.log('  Name:', name);
          console.log('  Symbol:', symbol);
          console.log('  Creator:', creator);

          // Parse transaction data directly from blockchain
          handleTokenCreated(tokenAddress, name, symbol, log.transactionHash, { blockNumber: log.blockNumber });
        }
      } catch (error) {
        console.error('Error decoding event:', error.message);

        // Fallback: try to extract just the address
        if (log.topics.length >= 2) {
          const potentialAddress = '0x' + log.topics[1].slice(26);
          handleTokenCreated(potentialAddress, '', '', log.transactionHash, { blockNumber: log.blockNumber });
        }
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
