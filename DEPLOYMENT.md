# 🚀 Deployment Guide - WebSocket Architecture

This guide will help you deploy the new WebSocket-based architecture for 2-3 second token detection.

## Architecture Overview

```
Railway (WebSocket Listener)
    ↓ Monitors Base blockchain via WebSocket
    ↓ Detects new Clanker tokens instantly (2-3s)
    ↓ Fetches social context from Clanker API
    ↓ POST to Vercel webhook
Vercel (/api/webhook)
    ↓ Stores in cache
Frontend
    ↓ Polls cache every 1s
    ↓ Displays with tweet embeds ✓
```

## Step 1: Deploy Vercel (Frontend + Webhook)

### Add Environment Variable
In your Vercel dashboard, add:
```
WEBHOOK_SECRET=your-secret-key-here
```
(Use a strong random string)

### Deploy
```bash
git add .
git commit -m "Add WebSocket architecture"
git push
```

Vercel will auto-deploy. Note your URL: `https://your-app.vercel.app`

## Step 2: Deploy Railway (WebSocket Listener)

### Option A: Deploy via Railway Dashboard (Recommended)

1. Go to [Railway.app](https://railway.app) and sign in
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Connect your repo and select the `railway-listener` folder
5. Add environment variables in Railway dashboard:

```
WSS_URL=wss://your-wss-url-here
CLANKER_FACTORY=0xe85a59c628f7d27878aceb4bf3b35733630083a9
WEBHOOK_URL=https://your-app.vercel.app/api/webhook
WEBHOOK_SECRET=your-secret-key-here
```

6. Click "Deploy"

### Option B: Deploy via Railway CLI

```bash
cd railway-listener
npm install -g @railway/cli
railway login
railway init
railway up
```

Then add environment variables in Railway dashboard.

## Step 3: Configure Environment Variables

### In Railway Dashboard:

1. **WSS_URL**: Your Base RPC WebSocket URL
   - Example: `wss://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY`
   - Or use QuickNode, Infura, etc.

2. **CLANKER_FACTORY**: `0xe85a59c628f7d27878aceb4bf3b35733630083a9`

3. **WEBHOOK_URL**: Your Vercel webhook endpoint
   - Format: `https://your-app.vercel.app/api/webhook`

4. **WEBHOOK_SECRET**: Same secret you set in Vercel
   - Use a strong random string

## Step 4: Verify It's Working

### Check Railway Logs
In Railway dashboard, go to "Deployments" → "View Logs"

You should see:
```
🔌 Connecting to Base RPC via WebSocket...
✅ Connected to network: base (chainId: 8453)
📡 Listening to Clanker Factory: 0xe85a...
👂 Listening for new token deployments...
```

### When New Token Deploys:
```
🚀 NEW TOKEN DETECTED!
Address: 0x...
Name: MyToken
Symbol: TKN
Fetching token data from Clanker API...
✅ Successfully posted TKN to webhook
```

### Check Your Frontend
Open your app - new tokens should appear in 2-3 seconds!

## Troubleshooting

### Railway shows "WebSocket error"
- Check your WSS_URL is correct
- Verify your RPC provider allows WebSocket connections
- Check RPC provider isn't rate limiting

### No tokens appearing in frontend
- Check Railway logs for errors
- Verify WEBHOOK_URL is correct
- Check WEBHOOK_SECRET matches in both Railway and Vercel
- Check Vercel function logs in dashboard

### Tokens appear but no tweet embeds
- This means Railway is detecting tokens but Clanker API doesn't have social data yet
- The Railway listener retries 5 times with 2s delays
- Should resolve within 10 seconds

## Testing

To test the webhook manually:

```bash
curl -X POST https://your-app.vercel.app/api/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret-key" \
  -d '{
    "contract_address": "0x123...",
    "name": "Test Token",
    "symbol": "TEST",
    "created_at": "2024-01-01T00:00:00Z"
  }'
```

Then check your frontend - you should see the test token appear.

## Cost

- **Vercel**: Free tier (no changes)
- **Railway**: Free tier includes 500 hours/month
  - This service uses ~720 hours/month (24/7)
  - **Hobby plan: $5/month** (recommended for 24/7 operation)

## Rollback (If Needed)

If something goes wrong, you can quickly rollback:

1. **Stop Railway service** (pause in dashboard)
2. **Revert frontend change** in `src/app/page.tsx`:
   ```typescript
   // Change back to:
   const res = await fetch("/api/tokens");
   ```
3. **Redeploy Vercel**

The old `/api/tokens` endpoint still exists as backup.

## Next Steps (Optional Improvements)

1. **Use Vercel KV for persistence**: Currently using in-memory cache (resets on deploy)
2. **Add monitoring**: Set up alerts for Railway downtime
3. **Optimize event detection**: Update ABI once we confirm exact event structure
4. **Add WebSocket reconnection improvements**: More robust error handling

## Need Help?

Check the logs:
- **Railway**: Dashboard → Deployments → View Logs
- **Vercel**: Dashboard → Functions → Logs

Common issues are usually:
- Incorrect environment variables
- RPC provider WebSocket not enabled
- WEBHOOK_SECRET mismatch
