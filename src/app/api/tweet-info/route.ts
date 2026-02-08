import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tweetUrl = searchParams.get("url");

  if (!tweetUrl) {
    return NextResponse.json({ error: "url param required" }, { status: 400 });
  }

  try {
    // Convert twitter.com/x.com URL to FxTwitter API URL
    const fxUrl = tweetUrl
      .replace("https://twitter.com/", "https://api.fxtwitter.com/")
      .replace("https://x.com/", "https://api.fxtwitter.com/");

    const response = await fetch(fxUrl, {
      headers: { "User-Agent": "ClankerScanner/1.0" },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `FxTwitter ${response.status}` },
        {
          status: response.status,
          headers: { "Cache-Control": "public, s-maxage=300" },
        }
      );
    }

    const data = await response.json();
    const tweet = data.tweet;

    if (!tweet) {
      return NextResponse.json(
        { tweet_text: null, author: null, reply_to_username: null },
        { headers: { "Cache-Control": "public, s-maxage=3600" } }
      );
    }

    return NextResponse.json(
      {
        tweet_text: tweet.text || null,
        author: tweet.author?.screen_name || null,
        reply_to_username: tweet.replying_to || null,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
        },
      }
    );
  } catch (error: unknown) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return NextResponse.json({ error: "timeout" }, { status: 504 });
    }
    return NextResponse.json({ error: "fetch failed" }, { status: 500 });
  }
}
