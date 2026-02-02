import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tweetUrl = searchParams.get('url');

  if (!tweetUrl) {
    return NextResponse.json(
      { error: 'Tweet URL required' },
      { status: 400 }
    );
  }

  try {
    // Fetch the tweet page HTML
    const response = await fetch(tweetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch tweet: ${response.status}` },
        { status: response.status }
      );
    }

    const html = await response.text();

    // Try multiple patterns to extract replied-to username

    // Pattern 1: Look for "Replying to @username" in meta tags or page content
    const replyingToMetaMatch = html.match(/"replying_to_status_author_username":"([a-zA-Z0-9_]+)"/);
    if (replyingToMetaMatch) {
      return NextResponse.json({ replied_to_username: replyingToMetaMatch[1] });
    }

    // Pattern 2: Look for in_reply_to_screen_name in page data
    const inReplyToMatch = html.match(/"in_reply_to_screen_name":"([a-zA-Z0-9_]+)"/);
    if (inReplyToMatch) {
      return NextResponse.json({ replied_to_username: inReplyToMatch[1] });
    }

    // Pattern 3: Look for "Replying to" text with username link
    const replyingToTextMatch = html.match(/Replying to.*?@([a-zA-Z0-9_]+)/i);
    if (replyingToTextMatch) {
      return NextResponse.json({ replied_to_username: replyingToTextMatch[1] });
    }

    // No reply-to information found
    return NextResponse.json({ replied_to_username: null });

  } catch (error) {
    console.error('Error extracting reply-to:', error);
    return NextResponse.json(
      { error: 'Failed to extract reply-to information' },
      { status: 500 }
    );
  }
}
