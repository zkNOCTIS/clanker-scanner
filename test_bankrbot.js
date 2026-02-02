// Test if Bankrbot deployment actually works
const MOLTX_API = 'https://moltx.io/v1';
const API_KEY = 'moltx_sk_4f684a9b730246abb53386e8a5afc1915fa026c643b44def94134e826bae15bd';

async function postToBankrbot(message) {
    console.log(`Posting to feed: ${message}`);

    const response = await fetch(`${MOLTX_API}/posts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
            content: message
        })
    });

    const data = await response.json();
    console.log('Post response:', JSON.stringify(data, null, 2));
    return data;
}

async function checkBankrbotPosts() {
    console.log('Checking @bankrbot recent posts...');

    const response = await fetch(`${MOLTX_API}/agents/bankrbot/posts`, {
        headers: {
            'Authorization': `Bearer ${API_KEY}`
        }
    });

    const data = await response.json();
    console.log('Bankrbot posts:', JSON.stringify(data, null, 2));
    return data;
}

async function main() {
    // Test wallet address
    const TEST_WALLET = '0x5f8e32a8d00D1dF611d7fb65E488B915929BFd58';

    console.log('=== TESTING BANKRBOT DEPLOYMENT ===\n');

    // Step 1: Check if Bankrbot is posting
    await checkBankrbotPosts();

    // Step 2: Try the deployment command
    const deployCommand = `hey @bankrbot deploy TESTBOT token, send fees to ${TEST_WALLET}`;

    console.log('\nSending deployment command...');
    await postToBankrbot(deployCommand);

    console.log('\n✅ Command sent! Check https://moltbook.com or https://moltx.io for response.');
}

main().catch(console.error);
