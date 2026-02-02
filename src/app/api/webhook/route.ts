import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

// Initialize Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const REDIS_KEY = "clanker:tokens";
const MAX_TOKENS = 100;
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

    // Get existing tokens from Redis
    const existingTokens = await redis.get<any[]>(REDIS_KEY) || [];

    // Add new token to the beginning
    const updatedTokens = [tokenData, ...existingTokens];

    // Trim to max size
    if (updatedTokens.length > MAX_TOKENS) {
      updatedTokens.length = MAX_TOKENS;
    }

    // Save back to Redis
    await redis.set(REDIS_KEY, updatedTokens);

    console.log(`✅ Token cached in Redis. Total: ${updatedTokens.length}`);

    return NextResponse.json({
      success: true,
      cached: updatedTokens.length
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

    // Get tokens from Redis
    const tokens = await redis.get<any[]>(REDIS_KEY) || [];

    // Return limited tokens
    return NextResponse.json({
      data: tokens.slice(0, limit),
      count: tokens.length,
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
