import fs from "node:fs";
import path from "node:path";
import type { ClaudeEvent, PruneOptions, ContentBlock } from "./types.js";
import { parseSessionFile } from "./tree.js";
import { estimateTokens } from "./meter.js";

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
export async function pruneSessionFile(
  filePath: string,
  options: PruneOptions = {}
): Promise<PruneResult> {
  const tree = await parseSessionFile(filePath);
  const originalStat = fs.statSync(filePath);
  const originalTokens = tree.rawEstimatedTokens;

  const maxToolChars = options.maxToolOutputChars || 2000;
  const pruneDead = options.pruneDeadBranches !== false;
  const truncateTools = options.truncateToolOutputs !== false;
  const collapseThinking = options.collapseOldThinking !== false;

  let deadEventsRemoved = 0;
  let toolOutputsTruncated = 0;
  let thinkingBlocksCompressed = 0;

  // Filter and transform events
  const prunedEvents: ClaudeEvent[] = [];
  const totalEventsCount = tree.events.length;

  for (let index = 0; index < totalEventsCount; index++) {
    const event = tree.events[index];

    // 1. Evict dead branches / orphaned forks
    if (pruneDead && event.uuid && tree.deadBranchUuids.has(event.uuid)) {
      deadEventsRemoved++;
      continue;
    }

    // Clone event to avoid modifying in-memory originals
    const prunedEvent = JSON.parse(JSON.stringify(event)) as ClaudeEvent;

    // If UUID was synthesized for an event that didn't have one originally, restore clean schema
    if (prunedEvent._synthUuid) {
      delete prunedEvent.uuid;
      delete prunedEvent._synthUuid;
    }

    // Is this an older turn? (e.g. not in the latest 3 turns)
    const isHistoricalTurn = index < totalEventsCount - 3;

    // 2. Prune and truncate oversized tool outputs
    if (truncateTools) {
      // Claude Code top-level tool_result
      if (prunedEvent.tool_result) {
        const truncated = truncateOutputPayload(prunedEvent.tool_result, maxToolChars);
        if (truncated.didTruncate) {
          prunedEvent.tool_result = truncated.data;
          toolOutputsTruncated++;
        }
      }

      // Claude Code tool_result inside message.content array
      if (Array.isArray(prunedEvent.message?.content)) {
        prunedEvent.message.content = prunedEvent.message.content.map((block: ContentBlock) => {
          if (block.type === "tool_result") {
            const rawContent = block.content || block.output;
            if (rawContent) {
              const res = truncateOutputPayload(rawContent, maxToolChars);
              if (res.didTruncate) {
                toolOutputsTruncated++;
                if (block.content) block.content = res.data;
                if (block.output) block.output = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
              }
            }
          }

          // 3. Compress historical extended thinking blocks (Claude Code)
          if (collapseThinking && isHistoricalTurn && (block.type === "thinking" || block.thinking)) {
            const thinkingText = block.thinking || block.text || "";
            if (thinkingText.length > 500 && !thinkingText.includes("historical thinking compressed")) {
              thinkingBlocksCompressed++;
              const collapsed = `[claude-prune: historical thinking compressed (${Math.round(thinkingText.length / 3.8)} tokens saved)]`;
              if (block.thinking) block.thinking = collapsed;
              if (block.text) block.text = collapsed;
            }
          }

          return block;
        });
      }

      // Codex CLI: output (function_call_output, exec_command, etc.)
      if (prunedEvent.output) {
        const truncated = truncateOutputPayload(prunedEvent.output, maxToolChars);
        if (truncated.didTruncate) {
          prunedEvent.output = truncated.data;
          toolOutputsTruncated++;
        }
      }

      // Codex CLI: stdout and stderr
      if (typeof prunedEvent.stdout === "string") {
        const truncated = truncateOutputPayload(prunedEvent.stdout, maxToolChars);
        if (truncated.didTruncate) {
          prunedEvent.stdout = truncated.data;
          toolOutputsTruncated++;
        }
      }
      if (typeof prunedEvent.stderr === "string") {
        const truncated = truncateOutputPayload(prunedEvent.stderr, maxToolChars);
        if (truncated.didTruncate) {
          prunedEvent.stderr = truncated.data;
          toolOutputsTruncated++;
        }
      }

      // OpenAI / Codex: role === "tool" message content
      if (prunedEvent.role === "tool" && typeof prunedEvent.content === "string") {
        const truncated = truncateOutputPayload(prunedEvent.content, maxToolChars);
        if (truncated.didTruncate) {
          prunedEvent.content = truncated.data;
          toolOutputsTruncated++;
        }
      }

      // Codex CLI: official payload structure (custom_tool_call_output, item_completed, base64 images)
      const p = prunedEvent.payload;
      if (p) {
        // (a) custom_tool_call_output & function_call_output
        if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
          if (typeof p.output === "string") {
            const res = truncateOutputPayload(p.output, maxToolChars);
            if (res.didTruncate) {
              p.output = res.data;
              toolOutputsTruncated++;
            }
          } else if (Array.isArray(p.output)) {
            for (const block of p.output) {
              if (block && typeof block.text === "string") {
                const res = truncateOutputPayload(block.text, maxToolChars);
                if (res.didTruncate) {
                  block.text = res.data;
                  toolOutputsTruncated++;
                }
              }
            }
          }
        }

        // (b) item_completed duplicate outputs
        if (prunedEvent.type === "event_msg" && p.type === "item_completed" && p.item) {
          for (const outKey of ["result", "aggregated_output", "output"]) {
            const val = p.item[outKey];
            if (typeof val === "string") {
              const res = truncateOutputPayload(val, maxToolChars);
              if (res.didTruncate) {
                p.item[outKey] = res.data;
                toolOutputsTruncated++;
              }
            }
          }
        }

        // (c) Base64 images compacted across payload and replacement_history
        function cleanImages(node: any) {
          if (!node) return;
          if (typeof node === "object") {
            for (const [k, v] of Object.entries(node)) {
              if (typeof v === "string" && v.startsWith("data:image/") && v.length > 500 && !v.includes("claude-prune: image")) {
                node[k] = `[claude-prune: image payload compacted (${Math.round(v.length / 3.8)} tokens saved)]`;
                toolOutputsTruncated++;
              } else if (typeof v === "object") {
                cleanImages(v);
              }
            }
          }
        }
        cleanImages(p);
      }
    }

    // Historical thinking / reasoning compression (Claude Code + Codex)
    if (collapseThinking && isHistoricalTurn) {
      if (prunedEvent.thinking) {
        const thinkingStr = typeof prunedEvent.thinking === "string" 
          ? prunedEvent.thinking 
          : JSON.stringify(prunedEvent.thinking);
        if (thinkingStr.length > 500 && !thinkingStr.includes("historical thinking compressed")) {
          thinkingBlocksCompressed++;
          prunedEvent.thinking = "[claude-prune: historical thinking compressed]";
        }
      }
      if (typeof prunedEvent.reasoning_content === "string" && prunedEvent.reasoning_content.length > 500 && !prunedEvent.reasoning_content.includes("historical thinking compressed")) {
        thinkingBlocksCompressed++;
        prunedEvent.reasoning_content = "[claude-prune: historical thinking compressed]";
      }
      if (typeof prunedEvent.thought === "string" && prunedEvent.thought.length > 500 && !prunedEvent.thought.includes("historical thinking compressed")) {
        thinkingBlocksCompressed++;
        prunedEvent.thought = "[claude-prune: historical thinking compressed]";
      }
      if (prunedEvent.payload?.type === "reasoning") {
        const rVal = prunedEvent.payload.encrypted_content || prunedEvent.payload.content;
        if (typeof rVal === "string" && rVal.length > 500 && !rVal.includes("claude-prune: historical")) {
          thinkingBlocksCompressed++;
          prunedEvent.payload.encrypted_content = "[claude-prune: historical reasoning trace compressed]";
        }
      }
    }

    prunedEvents.push(prunedEvent);
  }

  // Calculate new tokens
  let newTokens = 0;
  for (const ev of prunedEvents) {
    newTokens += estimateTokens(ev);
  }

  const tokensSaved = Math.max(0, originalTokens - newTokens);
  const savingsPercent = originalTokens > 0 
    ? Math.round((tokensSaved / originalTokens) * 100) 
    : 0;

  let backupPath: string | null = null;

  // If dry-run, do not write to disk
  if (!options.dryRun) {
    // Create backup file if requested (default true)
    if (options.createBackup !== false) {
      backupPath = `${filePath}.bak.jsonl`;
      fs.copyFileSync(filePath, backupPath);
    }

    // Write pruned output safely with retry and fallback for Windows file locks
    const outputLines = prunedEvents.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
    safeWriteFile(filePath, outputLines);
  }

  const newSizeBytes = options.dryRun 
    ? Math.round(originalStat.size * (1 - savingsPercent / 100))
    : fs.statSync(filePath).size;

  return {
    filePath,
    backupPath,
    originalSizeBytes: originalStat.size,
    newSizeBytes,
    originalTokens,
    newTokens,
    tokensSaved,
    savingsPercent,
    deadEventsRemoved,
    toolOutputsTruncated,
    thinkingBlocksCompressed,
  };
}

/**
 * Safely writes pruned output to disk with retry backoff and Windows lock resolution.
 * Prevents EPERM errors when Claude Code holds an open handle to the active session.
 */
function safeWriteFile(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf-8" });

    // Windows retry loop for renameSync (handles temporary lock while Claude Code flushes)
    let retries = 5;
    let delay = 100;

    while (retries > 0) {
      try {
        fs.renameSync(tempPath, filePath);
        return; // Success!
      } catch (err: any) {
        if (err.code === "EPERM" || err.code === "EBUSY") {
          retries--;
          if (retries === 0) {
            // Fallback: Copy content directly then remove temp file
            try {
              fs.copyFileSync(tempPath, filePath);
              try { fs.unlinkSync(tempPath); } catch {}
              return; // Success via copy fallback!
            } catch {
              throw err; // rethrow original EPERM if copy also failed
            }
          }
          // Synchronous sleep for file handle release
          const stop = Date.now() + delay;
          while (Date.now() < stop) {}
          delay *= 1.5;
        } else {
          throw err;
        }
      }
    }
  } finally {
    // Ensure temporary file never lingers on disk
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
  }
}

/**
 * Truncates oversized string or object tool results while preserving head and tail.
 */
function truncateOutputPayload(data: any, maxChars: number): { data: any; didTruncate: boolean } {
  if (!data) return { data, didTruncate: false };

  // If object with output property (e.g. { command: "npm test", output: "..." })
  if (typeof data === "object" && data !== null && typeof data.output === "string") {
    const res = truncateOutputPayload(data.output, maxChars);
    if (res.didTruncate) {
      return {
        data: { ...data, output: res.data },
        didTruncate: true,
      };
    }
    return { data, didTruncate: false };
  }

  const isString = typeof data === "string";
  const str = isString ? data : JSON.stringify(data);

  if (str.length <= maxChars || str.includes("claude-prune: truncated")) {
    return { data, didTruncate: false };
  }

  const lines = str.split("\n");
  if (lines.length <= 20) {
    // If not many lines, just character slice
    const half = Math.floor(maxChars / 2);
    const head = str.slice(0, half);
    const tail = str.slice(str.length - half);
    const truncatedStr = `${head}\n\n... [claude-prune: truncated ${str.length - maxChars} characters of log payload to protect cache] ...\n\n${tail}`;
    return {
      data: isString ? truncatedStr : { _truncated: true, preview: truncatedStr },
      didTruncate: true,
    };
  }

  // Preserve first 10 lines and last 15 lines
  const headLines = lines.slice(0, 10).join("\n");
  const tailLines = lines.slice(lines.length - 15).join("\n");
  const omittedLineCount = lines.length - 25;

  const truncatedText = `${headLines}\n\n... [claude-prune: truncated ${omittedLineCount} lines of intermediate log to protect cache] ...\n\n${tailLines}`;

  return {
    data: isString ? truncatedText : { _truncated: true, preview: truncatedText },
    didTruncate: true,
  };
}

/**
 * Restores a session from its .bak.jsonl backup.
 */
export function restoreBackup(filePath: string): boolean {
  const backupPath = filePath.endsWith(".bak.jsonl") ? filePath : `${filePath}.bak.jsonl`;
  const originalPath = backupPath.replace(/\.bak\.jsonl$/, "");

  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, originalPath);
    return true;
  }
  return false;
}
