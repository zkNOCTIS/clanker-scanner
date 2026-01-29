"use client";

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    twttr?: {
      widgets: {
        load: (element?: HTMLElement) => void;
        createTweet: (
          tweetId: string,
          container: HTMLElement,
          options?: object
        ) => Promise<HTMLElement>;
      };
    };
  }
}

export function TweetEmbed({ tweetId }: { tweetId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load Twitter widget script if not already loaded
    if (!window.twttr) {
      const script = document.createElement("script");
      script.src = "https://platform.twitter.com/widgets.js";
      script.async = true;
      document.body.appendChild(script);
    }

    // Create the tweet embed
    const renderTweet = () => {
      if (window.twttr && containerRef.current) {
        containerRef.current.innerHTML = "";
        window.twttr.widgets.createTweet(tweetId, containerRef.current, {
          theme: "dark",
          cards: "visible",
          width: 550,
        });
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
    <div
      ref={containerRef}
      className="min-h-[200px] flex items-center justify-center"
    >
      <div className="text-gray-500 text-sm">Loading tweet...</div>
    </div>
  );
}
