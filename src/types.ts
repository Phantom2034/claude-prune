export interface ClaudeEvent {
  uuid: string;
  parentUuid: string | null;
  type: string; // "user" | "assistant" | "system" | "compact_boundary" etc.
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    role?: string;
    content?: string | Array<ContentBlock>;
  };
  tool_result?: any;
  tool_use?: any;
  thinking?: any;
  [key: string]: any;
}

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
  dryRun?: boolean;
  createBackup?: boolean;
  truncateToolOutputs?: boolean;
  maxToolOutputChars?: number;
  pruneDeadBranches?: boolean;
  dedupFileReads?: boolean;
  collapseOldThinking?: boolean;
}
