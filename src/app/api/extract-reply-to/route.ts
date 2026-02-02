import { NextResponse } from "next/server";

// Cache responses for 5 minutes to reduce API calls
export const revalidate = 300;

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
    // Extract tweet ID from URL
    const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);
    if (!tweetIdMatch) {
      return NextResponse.json({ replied_to_username: null });
    }
    const tweetId = tweetIdMatch[1];

    // Try Twitter's syndication API (used by embeds)
    try {
      const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=1`;
      const syndicationResponse = await fetch(syndicationUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });

      if (syndicationResponse.ok) {
        const syndicationData = await syndicationResponse.json();

        // Check for in_reply_to_screen_name in the response
        if (syndicationData?.in_reply_to_screen_name) {
          return NextResponse.json({
            replied_to_username: syndicationData.in_reply_to_screen_name
          });
        }

        // Also check parent field
        if (syndicationData?.parent?.user?.screen_name) {
          return NextResponse.json({
            replied_to_username: syndicationData.parent.user.screen_name
          });
        }
      }
    } catch (e) {
      console.log('Syndication API failed, trying oEmbed');
    }

    // Fallback: Try oEmbed API
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true`;
    const oembedResponse = await fetch(oembedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (oembedResponse.ok) {
      const oembedData = await oembedResponse.json();

      // Extract username from "Replying to @username" in the HTML
      if (oembedData?.html) {
        const replyMatch = oembedData.html.match(/Replying to\s+<a[^>]*>@([a-zA-Z0-9_]+)<\/a>/);
        if (replyMatch) {
          return NextResponse.json({ replied_to_username: replyMatch[1] });
        }
      }
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
