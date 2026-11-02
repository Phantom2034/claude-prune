import type { ClaudeEvent, SessionAnalysis, PruneOptions } from "./types.js";
export interface ParsedSessionTree {
    filePath: string;
    events: ClaudeEvent[];
    uuidMap: Map<string, ClaudeEvent>;
    activeUuids: Set<string>;
    deadBranchUuids: Set<string>;
    latestLeafUuid: string | null;
    rawEstimatedTokens: number;
}
/**
 * Reads and parses a Claude Code or Codex CLI .jsonl session file.
 */
export declare function parseSessionFile(filePath: string): Promise<ParsedSessionTree>;
/**
 * Traverses the event graph from the latest leaf node up to root.
 * Supports DAG graphs with parentUuid/parentId (Claude Code) and linear session logs (Codex CLI).
 */
export declare function analyzeConversationGraph(events: ClaudeEvent[], uuidMap: Map<string, ClaudeEvent>): {
    activeUuids: Set<string>;
    deadBranchUuids: Set<string>;
    latestLeafUuid: string | null;
};
/**
 * Accurately analyzes session metrics for genuine prunable bloat:
 * 1. Dead branches (orphaned forks from /compact or prompt edits).
 * 2. Uncompressed oversized tool outputs (> 2000 chars that aren't already truncated).
 * 3. Codex CLI exec_command stdout/stderr and patch payloads.
 * 4. Historical extended thinking / reasoning blocks on older turns.
 *
 * Never flags active code or real conversation messages as prunable.
 */
export declare function analyzeSession(filePath: string, projectName?: string, options?: PruneOptions): Promise<SessionAnalysis>;
