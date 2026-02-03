const fetch = require('node-fetch');

async function checkTweetEmbed() {
  // Try the oEmbed endpoint (public, no API key needed)
  const tweetId = '1886165042064560164';
  const url = `https://publish.twitter.com/oembed?url=https://x.com/dessetaaa/status/${tweetId}`;
  
  console.log(`Fetching oEmbed data...\n`);
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log('oEmbed data:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkTweetEmbed();
