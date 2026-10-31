/**
 * Token and cost estimation utility for Anthropic Claude models.
 */

// Average characters per token for mixed code + text (Claude tokenizer baseline)
const CHARS_PER_TOKEN = 3.8;

// Anthropic Claude 3.5 Sonnet standard pricing per 1M tokens
export const PRICING = {
  standardInputPerMillion: 3.00,
  cacheWritePerMillion: 3.75,
  cacheReadPerMillion: 0.30,
  standardOutputPerMillion: 15.00,
};

/**
 * Estimates token count from raw text or JSON object.
 */
export function estimateTokens(content: string | object | null | undefined): number {
  if (!content) return 0;
  const str = typeof content === "string" ? content : JSON.stringify(content);
  return Math.ceil(str.length / CHARS_PER_TOKEN);
}

/**
 * Calculates estimated dollar cost for cache reads given token count and number of turns.
 * In a multi-turn Claude Code session, the full context is re-read from cache on every subsequent turn.
 */
export function estimateCacheReadCost(tokens: number, turns = 20): number {
  const totalCachedReads = tokens * Math.max(1, turns);
  return (totalCachedReads / 1_000_000) * PRICING.cacheReadPerMillion;
}

/**
 * Formats token counts nicely (e.g. 1,200 -> 1.2k, 1,500,000 -> 1.5M).
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) {
    return (tokens / 1_000_000_000).toFixed(2) + "B";
  }
  if (tokens >= 1_000_000) {
    return (tokens / 1_000_000).toFixed(1) + "M";
  }
  if (tokens >= 1_000) {
    return (tokens / 1_000).toFixed(1) + "k";
  }
  return tokens.toLocaleString();
}

/**
 * Formats bytes to human-readable string (KB, MB, GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  if (bytes >= 1024) {
    return (bytes / 1024).toFixed(1) + " KB";
  }
  return bytes + " B";
}

/**
 * Formats currency values.
 */
export function formatCurrency(dollars: number): string {
  return `$${dollars.toFixed(2)}`;
}
