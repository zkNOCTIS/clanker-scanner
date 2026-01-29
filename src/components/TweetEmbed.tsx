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

    // Wait for Twitter script to load with timeout
    let attempts = 0;
    const maxAttempts = 100; // 10 seconds max
    const checkInterval = setInterval(() => {
      attempts++;
      if (window.twttr) {
        clearInterval(checkInterval);
        renderTweet();
      } else if (attempts >= maxAttempts) {
        // Timeout - assume tweet unavailable
        clearInterval(checkInterval);
        setStatus("deleted");
      }
    }, 100);

    // Cleanup
    return () => clearInterval(checkInterval);
  }, [tweetId]);

  return (
    <div className="min-h-[80px]">
      {/* Tweet container - always rendered, hidden when not success */}
      <div ref={containerRef} className={status === "success" ? "" : "hidden"} />

      {/* Status messages */}
      {status === "loading" && (
        <div className="flex items-center justify-center min-h-[80px]">
          <div className="text-gray-500 text-sm">Loading tweet...</div>
        </div>
      )}
      {status === "deleted" && contractAddress && (
        <div className="flex items-center justify-center min-h-[60px]">
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
      )}
    </div>
  );
}
