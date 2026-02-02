// Quick test script to verify WSS connection works
const { ethers } = require('ethers');

const WSS_URL = 'wss://base.drpc.org';
const CLANKER_FACTORY = '0xe85a59c628f7d27878aceb4bf3b35733630083a9';

async function testConnection() {
  console.log('🔌 Testing WebSocket connection...');
  console.log(`WSS: ${WSS_URL}`);
  console.log(`Factory: ${CLANKER_FACTORY}\n`);

  try {
    // Connect to Base via WebSocket
    const provider = new ethers.WebSocketProvider(WSS_URL);

    console.log('⏳ Connecting...');

    // Test basic connection
    const network = await provider.getNetwork();
    console.log(`✅ Connected to network: ${network.name}`);
    console.log(`   Chain ID: ${network.chainId}`);

    // Get current block number
    const blockNumber = await provider.getBlockNumber();
    console.log(`   Current block: ${blockNumber}\n`);

    // Try to get contract code to verify factory address
    console.log('🔍 Checking factory contract...');
    const code = await provider.getCode(CLANKER_FACTORY);

    if (code === '0x') {
      console.log('❌ No contract found at this address!');
      process.exit(1);
    }

    console.log(`✅ Factory contract verified (${code.length} bytes)\n`);

    // Try to listen for events (we'll need to determine the actual event signature)
    console.log('👂 Testing event listening...');
    console.log('   (This will listen for 30 seconds for any events)\n');

    // Listen to all events from the factory
    const filter = {
      address: CLANKER_FACTORY
    };

    provider.on(filter, (log) => {
      console.log('📥 Event detected!');
      console.log(`   Block: ${log.blockNumber}`);
      console.log(`   Transaction: ${log.transactionHash}`);
      console.log(`   Topics:`, log.topics);
      console.log(`   Data:`, log.data);
      console.log('');
    });

    // Also listen for new blocks
    provider.on('block', (blockNumber) => {
      console.log(`⛓️  New block: ${blockNumber}`);
    });

    // Keep running for 30 seconds
    console.log('⏰ Listening for 30 seconds...\n');

    await new Promise(resolve => setTimeout(resolve, 30000));

    console.log('\n✅ Test complete! WSS connection works.');
    console.log('\nIf you saw events above, we can parse them.');
    console.log('If no events, no new tokens were deployed in last 30s.\n');

    provider.destroy();
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run test
testConnection();
