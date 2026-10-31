import type { PruneOptions } from "./types.js";
export interface PruneResult {
    filePath: string;
    backupPath: string | null;
    originalSizeBytes: number;
    newSizeBytes: number;
    originalTokens: number;
    newTokens: number;
    tokensSaved: number;
    savingsPercent: number;
    deadEventsRemoved: number;
    toolOutputsTruncated: number;
    thinkingBlocksCompressed: number;
}
/**
 * Prunes and compacts a single Claude Code .jsonl session file safely.
 */
export declare function pruneSessionFile(filePath: string, options?: PruneOptions): Promise<PruneResult>;
/**
 * Restores a session from its .bak.jsonl backup.
 */
export declare function restoreBackup(filePath: string): boolean;
