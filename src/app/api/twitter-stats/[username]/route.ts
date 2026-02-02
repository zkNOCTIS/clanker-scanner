import { NextResponse } from "next/server";

const FRONTRUNPRO_API = 'https://loadbalance.frontrun.pro/api/v1/twitter';
const FRONTRUNPRO_SESSION_TOKEN = process.env.FRONTRUNPRO_SESSION_TOKEN;

export async function GET(
  req: Request,
  { params }: { params: { username: string } }
) {
  const { username } = params;

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
      return NextResponse.json(
        { error: `FrontRunPro API error: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();

    return NextResponse.json({
      smart_followers: data.smart_followers
    });

  } catch (error) {
    console.error('Error fetching Twitter stats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch Twitter stats' },
      { status: 500 }
    );
  }
}
