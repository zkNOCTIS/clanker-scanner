const fetch = require('node-fetch');

const NITTER_INSTANCES = [
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.unixfox.eu',
  'https://nitter.1d4.us',
  'https://nitter.net'
];

function parseFollowerCount(text) {
  text = text.replace(/,/g, '').trim();

  if (text.endsWith('K')) {
    return Math.round(parseFloat(text) * 1000);
  } else if (text.endsWith('M')) {
    return Math.round(parseFloat(text) * 1000000);
  } else {
    return parseInt(text) || 0;
  }
}

async function getTwitterStatsFromNitter(tweetUrl) {
  const usernameMatch = tweetUrl.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/);
  const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);

  if (!usernameMatch || !tweetIdMatch) {
    console.log('⚠️  Could not parse tweet URL');
    return null;
  }

  const username = usernameMatch[1];
  const tweetId = tweetIdMatch[1];

  for (const nitterInstance of NITTER_INSTANCES) {
    try {
      console.log(`Trying Nitter instance: ${nitterInstance}`);

      const tweetResponse = await fetch(`${nitterInstance}/${username}/status/${tweetId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      if (!tweetResponse.ok) {
        console.log(`Failed to fetch from ${nitterInstance}: ${tweetResponse.status}`);
        continue;
      }

      const html = await tweetResponse.text();

      const replyToMatch = html.match(/replying to <a href="\/([^"\/]+)"/i);

      if (replyToMatch) {
        const parentUsername = replyToMatch[1];
        console.log(`   This is a reply to @${parentUsername}`);

        const profileResponse = await fetch(`${nitterInstance}/${parentUsername}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (!profileResponse.ok) {
          console.log(`Failed to fetch profile for @${parentUsername}`);
          continue;
        }

        const profileHtml = await profileResponse.text();

        const followersMatch = profileHtml.match(/<span class="profile-stat-num">([^<]+)<\/span>\s*<span class="profile-stat-header">Followers<\/span>/i);

        if (followersMatch) {
          const followersText = followersMatch[1].trim();
          const followers = parseFollowerCount(followersText);

          console.log(`✅ Got follower count for @${parentUsername}: ${followers} (${followersText})`);

          return {
            username: parentUsername,
            followers: followers,
            followersText: followersText,
            isReply: true
          };
        }
      } else {
        console.log('   Not a reply tweet, skipping stats');
        return null;
      }

    } catch (error) {
      console.log(`Error with ${nitterInstance}: ${error.message}`);
      continue;
    }
  }

  console.log('❌ All Nitter instances failed');
  return null;
}

// Test with the Kovado example
const testTweetUrl = 'https://x.com/dessetaaa/status/1886165042064560164';
console.log(`\nTesting with: ${testTweetUrl}\n`);

getTwitterStatsFromNitter(testTweetUrl).then(result => {
  if (result) {
    console.log('\n✅ SUCCESS!');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\n❌ FAILED - No stats returned');
  }
}).catch(err => {
  console.error('\n❌ ERROR:', err);
});
