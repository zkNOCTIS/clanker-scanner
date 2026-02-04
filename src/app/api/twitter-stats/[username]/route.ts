import { NextResponse } from "next/server";

const FRONTRUNPRO_API = 'https://loadbalance.frontrun.pro/api/v1/twitter';
const FRONTRUNPRO_SESSION_TOKEN = process.env.FRONTRUNPRO_SESSION_TOKEN;

// Cache responses for 6 hours (smart followers change slowly)
export const revalidate = 21600;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params;

  if (!FRONTRUNPRO_SESSION_TOKEN) {
    return NextResponse.json(
      { error: 'FrontRunPro session token not configured' },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(`${FRONTRUNPRO_API}/${username}/smart-followers`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': `__Secure-frontrun.session_token=${FRONTRUNPRO_SESSION_TOKEN}`,
        'x-copilot-client-version': '0.0.186',
        'x-copilot-client-language': 'EN_US'
      }
    });

    if (!response.ok) {
      // Log rate limit headers if present
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      const rateLimitLimit = response.headers.get('x-ratelimit-limit');
      const rateLimitReset = response.headers.get('x-ratelimit-reset');
      const retryAfter = response.headers.get('retry-after');

      console.error(`FrontRunPro API error ${response.status} for ${username}:`, {
        rateLimitRemaining,
        rateLimitLimit,
        rateLimitReset,
        retryAfter,
        allHeaders: Object.fromEntries(response.headers.entries())
      });

      return NextResponse.json(
        {
          error: `FrontRunPro API error: ${response.status}`,
          rateLimitRemaining,
          rateLimitLimit,
          rateLimitReset,
          retryAfter
        },
        { status: response.status }
      );
    }

    const data = await response.json();

    console.log(`FrontRunPro response for ${username}:`, JSON.stringify(data));

    return NextResponse.json({
      smart_followers: data.data?.totalCount || 0
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=43200'
      }
    });

  } catch (error) {
    console.error('Error fetching Twitter stats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch Twitter stats' },
      { status: 500 }
    );
  }
}
