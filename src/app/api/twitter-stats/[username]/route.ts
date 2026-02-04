import { NextResponse } from "next/server";

const ALPHAGATE_API = 'https://api.alphagate.io/api/v1';
const ALPHAGATE_SESSION_ID = process.env.ALPHAGATE_SESSION_ID;
const ALPHAGATE_USER_ID = process.env.ALPHAGATE_USER_ID;

// Cache responses for 6 hours (smart followers change slowly)
export const revalidate = 21600;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params;

  if (!ALPHAGATE_SESSION_ID || !ALPHAGATE_USER_ID) {
    return NextResponse.json(
      { error: 'Alphagate credentials not configured' },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(`${ALPHAGATE_API}/child?username=${username}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'Cookie': `extensionSessionId=${ALPHAGATE_SESSION_ID}; userId=${ALPHAGATE_USER_ID}`,
        'Origin': 'https://alphagate.io',
        'Referer': 'https://alphagate.io/'
      }
    });

    if (!response.ok) {
      const errorBody = await response.text();

      console.error(`Alphagate API error ${response.status} for ${username}:`, {
        errorBody,
        allHeaders: Object.fromEntries(response.headers.entries())
      });

      return NextResponse.json(
        {
          error: `Alphagate API error: ${response.status}`,
          errorBody
        },
        { status: response.status }
      );
    }

    const data = await response.json();

    console.log(`Alphagate response for ${username}:`, JSON.stringify(data).slice(0, 500));

    // Extract key_followers_count from alphagate response
    const keyFollowers = data.data?.child?.key_followers_count || 0;

    return NextResponse.json({
      smart_followers: keyFollowers
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
