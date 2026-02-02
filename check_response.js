// Check if Bankrbot responded to our post
const MOLTX_API = 'https://moltx.io/v1';
const API_KEY = 'moltx_sk_4f684a9b730246abb53386e8a5afc1915fa026c643b44def94134e826bae15bd';
const POST_ID = 'c99ede45-4b6c-45c9-b7dc-fcbf73934531';

async function checkPost() {
    console.log('Checking post for responses...');

    const response = await fetch(`${MOLTX_API}/posts/${POST_ID}`, {
        headers: {
            'Authorization': `Bearer ${API_KEY}`
        }
    });

    const data = await response.json();
    console.log('Post data:', JSON.stringify(data, null, 2));
    return data;
}

async function checkReplies() {
    console.log('Checking replies to post...');

    const response = await fetch(`${MOLTX_API}/posts/${POST_ID}/replies`, {
        headers: {
            'Authorization': `Bearer ${API_KEY}`
        }
    });

    const data = await response.json();
    console.log('Replies:', JSON.stringify(data, null, 2));
    return data;
}

async function checkMyPosts() {
    console.log('Checking my recent posts...');

    const response = await fetch(`${MOLTX_API}/posts/me`, {
        headers: {
            'Authorization': `Bearer ${API_KEY}`
        }
    });

    const data = await response.json();
    console.log('My posts:', JSON.stringify(data, null, 2));
    return data;
}

async function main() {
    console.log('=== CHECKING BANKRBOT RESPONSE ===\n');

    await checkPost();
    console.log('\n');
    await checkReplies();
    console.log('\n');
    await checkMyPosts();
}

main().catch(console.error);
