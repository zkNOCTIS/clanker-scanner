import { NextResponse } from "next/server";

// Simple in-memory cache for tokens
// In production, consider using Vercel KV or Redis
const tokenCache: any[] = [];
const MAX_CACHE_SIZE = 100;

// Secret for webhook authentication
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-secret-key';

// POST endpoint - receives tokens from Railway listener
export async function POST(req: Request) {
  try {
    // Verify webhook secret
    const secret = req.headers.get('x-webhook-secret');
    if (secret !== WEBHOOK_SECRET) {
      console.error('❌ Invalid webhook secret');
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Parse token data from Railway
    const tokenData = await req.json();

    console.log('📥 Received token from Railway:', {
      symbol: tokenData.symbol,
      address: tokenData.contract_address,
      timestamp: new Date().toISOString()
    });

    // Add timestamp if not present
    if (!tokenData.received_at) {
      tokenData.received_at = new Date().toISOString();
    }

    // Add to cache (newest first)
    tokenCache.unshift(tokenData);

    // Trim cache to max size
    if (tokenCache.length > MAX_CACHE_SIZE) {
      tokenCache.length = MAX_CACHE_SIZE;
    }

    console.log(`✅ Token cached. Cache size: ${tokenCache.length}`);

    return NextResponse.json({
      success: true,
      cached: tokenCache.length
    });

  } catch (error) {
    console.error('Error processing webhook:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET endpoint - frontend polls this for new tokens
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get('limit') || '50');

    // Return cached tokens
    return NextResponse.json({
      data: tokenCache.slice(0, limit),
      count: tokenCache.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching tokens:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
