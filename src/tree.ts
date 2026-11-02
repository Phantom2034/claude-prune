import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { ClaudeEvent, SessionAnalysis, PruneOptions, ContentBlock, AgentType } from "./types.js";
import { estimateTokens, estimateCacheReadCost } from "./meter.js";

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
export async function parseSessionFile(filePath: string): Promise<ParsedSessionTree> {
  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const events: ClaudeEvent[] = [];
  const uuidMap = new Map<string, ClaudeEvent>();
  let rawEstimatedTokens = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as ClaudeEvent;
      // Synthesize UUID if missing (common in Codex linear rollout logs)
      if (!event.uuid && !event.id) {
        event._synthUuid = true;
      }
      const uuid = event.uuid || event.id || `evt-${events.length}`;
      event.uuid = uuid;
      events.push(event);
      uuidMap.set(uuid, event);
      rawEstimatedTokens += estimateTokens(event);
    } catch {
      // Ignore corrupted or partial lines safely
    }
  }

  // Find active trunk vs dead branches
  const { activeUuids, deadBranchUuids, latestLeafUuid } = analyzeConversationGraph(events, uuidMap);

  return {
    filePath,
    events,
    uuidMap,
    activeUuids,
    deadBranchUuids,
    latestLeafUuid,
    rawEstimatedTokens,
  };
}

/**
 * Traverses the event graph from the latest leaf node up to root.
 * Supports DAG graphs with parentUuid/parentId (Claude Code) and linear session logs (Codex CLI).
 */
export function analyzeConversationGraph(
  events: ClaudeEvent[],
  uuidMap: Map<string, ClaudeEvent>
): {
  activeUuids: Set<string>;
  deadBranchUuids: Set<string>;
  latestLeafUuid: string | null;
} {
  const activeUuids = new Set<string>();
  const deadBranchUuids = new Set<string>();

  if (events.length === 0) {
    return { activeUuids, deadBranchUuids, latestLeafUuid: null };
  }

  // Check if session uses parent pointers (DAG structure)
  const hasParentPointers = events.some(
    (e) => Boolean(e.parentUuid || e.parentId || e.parent_id)
  );

  // If linear stream (no parent pointers, typical in Codex CLI rollouts), all turns are active
  if (!hasParentPointers) {
    for (const e of events) {
      if (e.uuid) activeUuids.add(e.uuid);
    }
    const lastEvent = events[events.length - 1];
    return {
      activeUuids,
      deadBranchUuids,
      latestLeafUuid: lastEvent?.uuid ?? null,
    };
  }

  // Find the latest active leaf event (prefer assistant or user messages)
  let latestLeafUuid: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "assistant" || e.type === "user" || e.role === "assistant" || e.role === "user" || e.message) {
      latestLeafUuid = e.uuid || null;
      break;
    }
  }

  // If no user/assistant turn found, fall back to last recorded event
  if (!latestLeafUuid && events.length > 0) {
    latestLeafUuid = events[events.length - 1].uuid || null;
  }

  // Trace back up from latestLeafUuid to root
  let currentUuid = latestLeafUuid;
  while (currentUuid) {
    activeUuids.add(currentUuid);
    const node = uuidMap.get(currentUuid);
    const parent = node?.parentUuid || node?.parentId || node?.parent_id;
    if (!parent) {
      break;
    }
    currentUuid = parent;
  }

  // Any event not in activeUuids is considered a dead branch or orphan
  for (const event of events) {
    if (event.uuid && !activeUuids.has(event.uuid)) {
      deadBranchUuids.add(event.uuid);
    }
  }

  return { activeUuids, deadBranchUuids, latestLeafUuid };
}

/**
 * Accurately analyzes session metrics for genuine prunable bloat:
 * 1. Dead branches (orphaned forks from /compact or prompt edits).
 * 2. Uncompressed oversized tool outputs (> 2000 chars that aren't already truncated).
 * 3. Codex CLI exec_command stdout/stderr and patch payloads.
 * 4. Historical extended thinking / reasoning blocks on older turns.
 * 
 * Never flags active code or real conversation messages as prunable.
 */
export async function analyzeSession(
  filePath: string,
  projectName = "default",
  options: PruneOptions = {}
): Promise<SessionAnalysis> {
  const stat = fs.statSync(filePath);
  const tree = await parseSessionFile(filePath);

  const isCodex = options.agentType === "codex" ||
    filePath.toLowerCase().includes(".codex") ||
    path.basename(filePath).startsWith("rollout-");
  const agentType: AgentType = isCodex ? "codex" : "claude";

  let oversizedToolOutputs = 0;
  let tokensSaved = 0;
  const maxChars = options.maxToolOutputChars || 2000;
  const totalCount = tree.events.length;

  for (let idx = 0; idx < totalCount; idx++) {
    const event = tree.events[idx];

    // 1. Dead branch: Entire event will be pruned
    if (event.uuid && tree.deadBranchUuids.has(event.uuid) && options.pruneDeadBranches !== false) {
      tokensSaved += estimateTokens(event);
      continue;
    }

    const isHistoricalTurn = idx < totalCount - 3;

    // 2. Check top-level tool_result (Claude Code)
    if (event.tool_result) {
      const str = typeof event.tool_result === "string" ? event.tool_result : JSON.stringify(event.tool_result);
      if (str.length > maxChars && !str.includes("claude-prune: truncated")) {
        oversizedToolOutputs++;
        const savingsChars = str.length - maxChars;
        tokensSaved += Math.max(0, Math.ceil(savingsChars / 3.8));
      }
    }

    // 3. Check tool_result inside message.content array (Claude Code)
    if (Array.isArray(event.message?.content)) {
      for (const block of event.message.content as ContentBlock[]) {
        if (block.type === "tool_result") {
          const contentStr = typeof block.content === "string" ? block.content : JSON.stringify(block.content || block.output || "");
          if (contentStr.length > maxChars && !contentStr.includes("claude-prune: truncated")) {
            oversizedToolOutputs++;
            const savingsChars = contentStr.length - maxChars;
            tokensSaved += Math.max(0, Math.ceil(savingsChars / 3.8));
          }
        }

        // 4. Historical extended thinking blocks (Claude Code)
        if (isHistoricalTurn && (block.type === "thinking" || block.thinking)) {
          const thinkStr = block.thinking || block.text || "";
          if (thinkStr.length > 500 && !thinkStr.includes("historical thinking compressed")) {
            tokensSaved += Math.max(0, Math.ceil((thinkStr.length - 80) / 3.8));
          }
        }
      }
    }

    // 5. Codex CLI: Check output (function_call_output, exec_command, etc.)
    if (event.output) {
      const str = typeof event.output === "string" ? event.output : JSON.stringify(event.output);
      if (str.length > maxChars && !str.includes("claude-prune: truncated")) {
        oversizedToolOutputs++;
        const savingsChars = str.length - maxChars;
        tokensSaved += Math.max(0, Math.ceil(savingsChars / 3.8));
      }
    }

    // 6. Codex CLI: Check stdout and stderr
    if (typeof event.stdout === "string" && event.stdout.length > maxChars && !event.stdout.includes("claude-prune: truncated")) {
      oversizedToolOutputs++;
      const savingsChars = event.stdout.length - maxChars;
      tokensSaved += Math.max(0, Math.ceil(savingsChars / 3.8));
    }
    if (typeof event.stderr === "string" && event.stderr.length > maxChars && !event.stderr.includes("claude-prune: truncated")) {
      oversizedToolOutputs++;
      const savingsChars = event.stderr.length - maxChars;
      tokensSaved += Math.max(0, Math.ceil(savingsChars / 3.8));
    }

    // 7. OpenAI/Codex role === "tool" message content
    if (event.role === "tool" && typeof event.content === "string") {
      if (event.content.length > maxChars && !event.content.includes("claude-prune: truncated")) {
        oversizedToolOutputs++;
        const savingsChars = event.content.length - maxChars;
        tokensSaved += Math.max(0, Math.ceil(savingsChars / 3.8));
      }
    }

    // 8. Top-level thinking / reasoning on older turns (Claude + Codex)
    if (isHistoricalTurn) {
      const thinkVal = event.thinking || event.reasoning_content || event.thought;
      if (thinkVal) {
        const thinkStr = typeof thinkVal === "string" ? thinkVal : JSON.stringify(thinkVal);
        if (thinkStr.length > 500 && !thinkStr.includes("historical thinking compressed")) {
          tokensSaved += Math.max(0, Math.ceil((thinkStr.length - 80) / 3.8));
        }
      }
    }
  }

  // Ensure tokensSaved does not exceed raw tokens
  tokensSaved = Math.min(tokensSaved, tree.rawEstimatedTokens);
  const prunedEstimatedTokens = Math.max(0, tree.rawEstimatedTokens - tokensSaved);

  const savingsPercent = tree.rawEstimatedTokens > 0 
    ? Math.round((tokensSaved / tree.rawEstimatedTokens) * 100) 
    : 0;

  return {
    filePath,
    fileName: path.basename(filePath),
    projectName,
    agentType,
    fileSizeBytes: stat.size,
    totalEvents: tree.events.length,
    activeEvents: tree.activeUuids.size,
    deadBranchEvents: tree.deadBranchUuids.size,
    oversizedToolOutputs,
    rawEstimatedTokens: tree.rawEstimatedTokens,
    prunedEstimatedTokens,
    tokensSaved,
    savingsPercent,
    estimatedCacheReadSavingsPerTurn: estimateCacheReadCost(tokensSaved, 1),
  };
}
