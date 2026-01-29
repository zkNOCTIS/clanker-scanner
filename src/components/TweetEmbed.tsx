"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    twttr?: {
      widgets: {
        load: (element?: HTMLElement) => void;
        createTweet: (
          tweetId: string,
          container: HTMLElement,
          options?: object
        ) => Promise<HTMLElement | undefined>;
      };
    };
  }
}

export function TweetEmbed({ tweetId, contractAddress, onDeleted }: { tweetId: string; contractAddress?: string; onDeleted?: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);

    // Load Twitter widget script if not already loaded
    if (!window.twttr) {
      const script = document.createElement("script");
      script.src = "https://platform.twitter.com/widgets.js";
      script.async = true;
      document.body.appendChild(script);
    }

    // Create the tweet embed
    const renderTweet = async () => {
      if (window.twttr && containerRef.current) {
        containerRef.current.innerHTML = "";
        const element = await window.twttr.widgets.createTweet(tweetId, containerRef.current, {
          theme: "dark",
          cards: "visible",
          width: 550,
        });
        // Check if tweet failed to load
        if (!element) {
          setFailed(true);
          onDeleted?.();
        }
      }
    };

    // Timeout - if tweet doesn't load in 10s, show search link
    const timeout = setTimeout(() => setFailed(true), 10000);

    // Wait for Twitter script to load
    const checkInterval = setInterval(() => {
      if (window.twttr) {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        renderTweet();
      }
    }, 100);

    // Cleanup
    return () => {
      clearInterval(checkInterval);
      clearTimeout(timeout);
    };
  }, [tweetId]);

  if (failed) {
    return (
      <div className="min-h-[60px] flex items-center justify-center">
        <a
          href={`https://x.com/search?q=${contractAddress}&src=typed_query`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-gray-500 text-sm hover:text-white transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
          Search for tweet on X
        </a>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="min-h-[200px] flex items-center justify-center"
    >
      <div className="text-gray-500 text-sm">Loading tweet...</div>
    </div>
  );
}
