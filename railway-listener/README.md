# Clanker Token Listener - Railway Service

WebSocket service that monitors Base blockchain for new Clanker token deployments and forwards them to your Vercel webhook.

## Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and fill in:
- `WSS_URL`: Your Base RPC WebSocket URL (Alchemy/QuickNode)
- `CLANKER_FACTORY`: Clanker factory contract address
- `WEBHOOK_URL`: Your Vercel webhook endpoint (e.g., `https://your-app.vercel.app/api/webhook`)
- `WEBHOOK_SECRET`: Secret key for authenticating webhook requests

### 3. Run Locally (Testing)
```bash
npm start
```

### 4. Deploy to Railway

#### Option A: Connect GitHub Repo
1. Push this folder to GitHub
2. Go to [Railway](https://railway.app)
3. New Project → Deploy from GitHub repo
4. Select this folder
5. Add environment variables in Railway dashboard
6. Deploy!

#### Option B: Railway CLI
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### 5. Add Environment Variables in Railway
In Railway dashboard, add:
- `WSS_URL`
- `CLANKER_FACTORY`
- `WEBHOOK_URL`
- `WEBHOOK_SECRET`

## How It Works

1. Connects to Base blockchain via WebSocket
2. Listens for `TokenCreated` events from Clanker factory contract
3. When new token detected:
   - Fetches full token data from Clanker API (includes tweet/social context)
   - POSTs complete data to your Vercel webhook
4. Your frontend reads from webhook cache (super fast!)

## Monitoring

Railway provides logs and metrics. You'll see:
- `🚀 NEW TOKEN DETECTED!` when tokens are found
- `✅ Successfully posted` when webhook succeeds
- `❌ Webhook POST failed` if there are issues

## Cost

Railway free tier includes 500 hours/month. This service uses ~1-2 hours/day = ~30-60 hours/month (well within free tier).

For production, $5/month hobby plan recommended.
