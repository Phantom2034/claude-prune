/**
 * Token and cost estimation utility for Anthropic Claude models.
 */
export declare const PRICING: {
    standardInputPerMillion: number;
    cacheWritePerMillion: number;
    cacheReadPerMillion: number;
    standardOutputPerMillion: number;
};
/**
 * Estimates token count from raw text or JSON object.
 */
export declare function estimateTokens(content: string | object | null | undefined): number;
/**
 * Calculates estimated dollar cost for cache reads given token count and number of turns.
 * In a multi-turn Claude Code session, the full context is re-read from cache on every subsequent turn.
 */
export declare function estimateCacheReadCost(tokens: number, turns?: number): number;
/**
 * Formats token counts nicely (e.g. 1,200 -> 1.2k, 1,500,000 -> 1.5M).
 */
export declare function formatTokens(tokens: number): string;
/**
 * Formats bytes to human-readable string (KB, MB, GB).
 */
export declare function formatBytes(bytes: number): string;
/**
 * Formats currency values.
 */
export declare function formatCurrency(dollars: number): string;
