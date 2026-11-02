import type { AgentType } from "./types.js";
/**
 * Returns the resolved root Claude Code configuration directory.
 */
export declare function getClaudeRootDir(): string;
/**
 * Returns the path to the Claude projects directory.
 */
export declare function getClaudeProjectsDir(): string;
/**
 * Returns the resolved root Codex CLI configuration directory.
 */
export declare function getCodexRootDir(): string;
/**
 * Returns the path to the Codex sessions directory.
 */
export declare function getCodexSessionsDir(): string;
export interface DiscoveredSession {
    filePath: string;
    fileName: string;
    sessionId: string;
    agentType: AgentType;
    projectFolder: string;
    projectDisplayName: string;
    fileSizeBytes: number;
    lastModified: Date;
}
/**
 * Decodes the slugified Claude project directory name into a human-readable path.
 * e.g., "-Users-you-code-my-app" -> "/Users/you/code/my-app"
 * or "C--Users-you-code" -> "C:\Users\you\code"
 */
export declare function decodeProjectName(folderName: string): string;
/**
 * Discovers sessions across Claude Code and Codex CLI.
 */
export declare function discoverSessions(targetPath?: string, filterAgent?: AgentType): DiscoveredSession[];
