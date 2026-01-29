import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { hostname: "pbs.twimg.com" },
      { hostname: "*.mypinata.cloud" },
      { hostname: "ipfs.io" },
      { hostname: "*.ipfs.io" },
    ],
  },
};

export default nextConfig;
