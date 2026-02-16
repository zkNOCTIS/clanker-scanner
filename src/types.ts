export interface ClankerToken {
  id?: number;
  name: string;
  symbol: string;
  contract_address: string;
  requestor_fid?: number;
  admin?: string;
  cast_hash?: string;
  tx_hash: string;
  type?: string;
  description?: string;
  img_url?: string;
  image_url?: string; // Railway format
  ipfs_cid?: string; // New IPFS format
  creator_address?: string | null; // Railway format
  twitter_link?: string | null; // Railway format
  farcaster_link?: string | null; // Railway format
  website_link?: string | null; // Railway format
  telegram_link?: string | null; // Railway format
  discord_link?: string | null; // Railway format
  received_at?: string; // Railway format
  social_context?: {
    interface: string;
    platform: string;
    messageId: string;
    id: string;
    xUsername?: string | null; // X username for verified Farcaster users
  };
  twitter_stats?: {
    replied_to_username: string;
    replied_to_followers: number;
    replied_to_followers_text: string;
  } | null;
  socialLinks?: Array<{
    name: string;
    link: string;
  }>;
  metadata?: {
    socialMediaUrls?: Array<{
      url: string;
      platform: string;
    }>;
    description?: string;
  };
  extensions?: {
    fees: {
      recipients: Array<{
        bps: number;
        recipient: string;
        admin: string;
      }>;
    };
  };
  factory_type?: "bankr" | "clanker" | "virtuals" | "noice";
  virtuals_url?: string;
  noice_url?: string;
  acp_stats?: {
    success_rate: number;
    jobs_completed: number;
    unique_buyers: number;
    rating: number | null;
    twitter_handle: string | null;
    acp_agent_id: number | null;
  } | null;
  farcaster_stats?: {
    cast_text: string;
    author_username: string;
    author_display_name: string;
    author_pfp: string | null;
    author_fid: number | null;
    follower_count: number;
    following_count: number;
    bio: string;
    power_badge: boolean;
    x_username: string | null;
  } | null;
  starting_market_cap?: number;
  created_at: string;
  msg_sender?: string;
  tags?: {
    verified?: boolean;
    champagne?: boolean;
  };
}

export function getTwitterUsername(url: string): string | null {
  const match = url.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/);
  const username = match ? match[1] : null;
  const internal = ["i", "intent", "share", "search", "hashtag", "home", "explore", "notifications", "messages", "settings"];
  if (username && internal.includes(username.toLowerCase())) return null;
  return username;
}

export function getTweetId(url: string): string | null {
  // Try to extract from URL with /status/
  const match = url.match(/status\/(\d+)/);
  if (match) return match[1];

  // If it's just a number (tweet ID directly), return it
  if (/^\d{10,}$/.test(url)) return url;

  return null;
}

export function getTweetUrl(token: ClankerToken): string | null {
  // Check Railway format first (direct field)
  if (token.twitter_link && (token.twitter_link.includes("twitter.com") || token.twitter_link.includes("x.com"))) {
    return token.twitter_link;
  }

  // Check old Clanker API format
  const messageId = token.social_context?.messageId || "";
  if (messageId.includes("twitter.com") || messageId.includes("x.com")) {
    return messageId;
  }

  // Try to construct from ID
  const id = token.social_context?.id;
  if (id && /^\d{10,}$/.test(id)) {
    const username = getTwitterUsername(messageId);
    if (username) return `https://x.com/${username}/status/${id}`;
  }

  // Check socialLinks for X/Twitter URL
  const socialLinks = token.socialLinks || [];
  const xLink = socialLinks.find(l => l.name === "x" && l.link);
  if (xLink?.link && (xLink.link.includes("twitter.com") || xLink.link.includes("x.com"))) {
    return xLink.link;
  }

  // Check metadata socialMediaUrls
  const socialUrls = token.metadata?.socialMediaUrls || [];
  const twitterUrl = socialUrls.find(u => u.platform === "twitter" || u.platform === "x");
  if (twitterUrl?.url) {
    return twitterUrl.url;
  }

  return null;
}

export function getCastUrl(token: ClankerToken): string | null {
  const castHash = token.cast_hash;
  if (castHash && castHash.startsWith("0x")) {
    return `https://warpcast.com/~/conversations/${castHash}`;
  }
  return null;
}

// Blocklisted Twitter usernames (spammers who delete tweets)
const BLOCKED_USERNAMES: string[] = [
  "dront08",
  "donibas27",
  "botak1118",
  "b0bbythakkar",
];

// Blocked Farcaster usernames (spam deployers)
const BLOCKED_FC_USERNAMES: string[] = [
  "bondings.base.eth",
  "maspin.eth",
  "primenode.eth",
  "amzgaming",
  "thejack",
];

export function hasRealSocialContext(token: ClankerToken): boolean {
  // Virtuals and Noice tokens are pre-filtered server-side
  if (token.factory_type === "virtuals") return true;
  if (token.factory_type === "noice") return true;

  // Railway format - check twitter_link directly
  if (token.twitter_link) {
    const tweetUrl = token.twitter_link;
    const urlUsername = getTwitterUsername(tweetUrl);
    // Block if username is blocklisted
    if (urlUsername && BLOCKED_USERNAMES.includes(urlUsername.toLowerCase())) {
      return false;
    }
    // Must have valid tweet ID for embedding
    const tweetId = getTweetId(tweetUrl);
    if (tweetId) return true;
  }

  // Old Clanker API format checks
  const castHash = token.cast_hash || "";

  // Block tokens with moltx.io links (spam platform)
  const socialLinks = token.socialLinks || [];
  const hasMoltx = socialLinks.some(l =>
    l.link?.toLowerCase().includes('moltx.io')
  );
  if (hasMoltx) return false;

  // Check if deployer is blocklisted
  const msgId = token.social_context?.messageId || "";
  const username = getTwitterUsername(msgId);
  if (username && BLOCKED_USERNAMES.includes(username.toLowerCase())) {
    return false;
  }

  // For X/Twitter - must have extractable tweet ID for embedding
  const tweetUrl = getTweetUrl(token);
  if (tweetUrl) {
    // Also check username from tweet URL
    const urlUsername = getTwitterUsername(tweetUrl);
    if (urlUsername && BLOCKED_USERNAMES.includes(urlUsername.toLowerCase())) {
      return false;
    }
    const tweetId = getTweetId(tweetUrl);
    if (tweetId) return true;
  }

  // Also check messageId and social_context.id directly
  const messageId = token.social_context?.messageId || "";
  const socialId = token.social_context?.id || "";
  if (getTweetId(messageId) || getTweetId(socialId)) return true;

  // Farcaster tokens — block spammers by username
  const fcUsername = token.farcaster_stats?.author_username?.toLowerCase() || "";
  if (fcUsername && BLOCKED_FC_USERNAMES.includes(fcUsername)) return false;

  // Farcaster tokens — show all with valid cast hash
  if (castHash && castHash.startsWith("0x")) return true;
  if (token.social_context?.xUsername) return true;

  // Tokens with 2+ UNIQUE social links (different URLs)
  // Filters out scams where all links point to same URL
  const allSocialLinks = token.socialLinks || [];
  const validLinks = allSocialLinks.filter(l => l.link && l.link.length > 0);

  // Check we have 2+ different URLs (not all same link)
  const uniqueUrls = new Set(validLinks.map(l => l.link));
  if (uniqueUrls.size >= 2) return true;

  return false;
}

