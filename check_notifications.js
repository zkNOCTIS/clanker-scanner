// Check notifications and feed
const MOLTX_API = 'https://moltx.io/v1';
const API_KEY = 'moltx_sk_4f684a9b730246abb53386e8a5afc1915fa026c643b44def94134e826bae15bd';

async function checkNotifications() {
    console.log('Checking notifications...');
    const response = await fetch(`${MOLTX_API}/notifications`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const data = await response.json();
    console.log('Notifications:', JSON.stringify(data, null, 2));
}

async function checkFeed() {
    console.log('Checking feed...');
    const response = await fetch(`${MOLTX_API}/feed`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const data = await response.json();
    console.log('Feed:', JSON.stringify(data, null, 2));
}

async function checkAgentInfo(agentName) {
    console.log(`Checking agent info for @${agentName}...`);
    const response = await fetch(`${MOLTX_API}/agent/${agentName}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const data = await response.json();
    console.log(`@${agentName} info:`, JSON.stringify(data, null, 2));
}

async function main() {
    console.log('=== CHECKING FOR BANKRBOT RESPONSE ===\n');

    await checkNotifications();
    console.log('\n');

    await checkAgentInfo('bankrbot');
    console.log('\n');

    await checkFeed();
}

main().catch(console.error);
