export type AgentType = "claude" | "codex";

export interface AgentEvent {
  uuid?: string;
  id?: string;
  parentUuid?: string | null;
  parentId?: string | null;
  parent_id?: string | null;
  type?: string; // "user" | "assistant" | "system" | "function_call" | "function_call_output" | etc.
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  role?: string; // "user" | "assistant" | "system" | "tool"
  name?: string; // tool name e.g. "exec_command", "apply_patch"
  output?: any;
  stdout?: any;
  stderr?: any;
  arguments?: any;
  payload?: any;
  reasoning_content?: string;
  thought?: string;
  message?: {
    role?: string;
    content?: string | Array<ContentBlock>;
  };
  tool_result?: any;
  tool_use?: any;
  thinking?: any;
  [key: string]: any;
}

// Alias for backwards compatibility
export type ClaudeEvent = AgentEvent;

export interface ContentBlock {
  type: string; // "text" | "tool_use" | "tool_result" | "thinking"
  text?: string;
  tool_use_id?: string;
  content?: string | Array<any>;
  output?: string;
  name?: string;
  input?: any;
  thinking?: string;
  [key: string]: any;
}

export interface SessionAnalysis {
  filePath: string;
  fileName: string;
  projectName: string;
  agentType: AgentType;
  fileSizeBytes: number;
  totalEvents: number;
  activeEvents: number;
  deadBranchEvents: number;
  oversizedToolOutputs: number;
  rawEstimatedTokens: number;
  prunedEstimatedTokens: number;
  tokensSaved: number;
  savingsPercent: number;
  estimatedCacheReadSavingsPerTurn: number;
}

export interface GlobalAuditReport {
  projectsScanned: number;
  sessionsScanned: number;
  totalFileSizeBytes: number;
  totalEstimatedTokens: number;
  potentialTokenSavings: number;
  potentialCacheReadSavings: number;
  sessions: SessionAnalysis[];
}

export interface PruneOptions {
  agentType?: AgentType;
  dryRun?: boolean;
  createBackup?: boolean;
  truncateToolOutputs?: boolean;
  maxToolOutputChars?: number;
  pruneDeadBranches?: boolean;
  dedupFileReads?: boolean;
  collapseOldThinking?: boolean;
}
