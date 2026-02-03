const fetch = require('node-fetch');

async function checkHTML() {
  const url = 'https://nitter.net/dessetaaa/status/1886165042064560164';
  console.log(`Fetching: ${url}\n`);
  
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  
  const html = await response.text();
  
  // Look for reply patterns
  console.log('Searching for reply patterns...\n');
  
  const patterns = [
    /replying to/gi,
    /reply-to/gi,
    /in-reply-to/gi,
    /reply/gi,
    /kavol/gi
  ];
  
  patterns.forEach(pattern => {
    const matches = html.match(pattern);
    if (matches) {
      console.log(`Found "${pattern}":`, matches.length, 'times');
      
      // Find context around first match
      const index = html.search(pattern);
      const context = html.substring(Math.max(0, index - 200), Math.min(html.length, index + 200));
      console.log('Context:', context.replace(/\s+/g, ' '));
      console.log('---\n');
    }
  });
}

checkHTML().catch(console.error);
