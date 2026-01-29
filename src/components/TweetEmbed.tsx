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

export function TweetEmbed({ tweetId, contractAddress }: { tweetId: string; contractAddress?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "success" | "deleted">("loading");

  useEffect(() => {
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
        // createTweet returns undefined if tweet doesn't exist
        if (element) {
          setStatus("success");
        } else {
          setStatus("deleted");
        }
      }
    };

    // Wait for Twitter script to load
    const checkInterval = setInterval(() => {
      if (window.twttr) {
        clearInterval(checkInterval);
        renderTweet();
      }
    }, 100);

    // Cleanup
    return () => clearInterval(checkInterval);
  }, [tweetId]);

  return (
    <div ref={containerRef} className="min-h-[80px] flex items-center justify-center">
      {status === "loading" && (
        <div className="text-gray-500 text-sm">Loading tweet...</div>
      )}
      {status === "deleted" && (
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-2 text-red-400 text-sm">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Tweet deleted
          </div>
          {contractAddress && (
            <a
              href={`https://x.com/search?q=${contractAddress}&src=typed_query`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-gray-400 text-xs hover:text-white transition-colors"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              Search on X
            </a>
          )}
        </div>
      )}
    </div>
  );
}
