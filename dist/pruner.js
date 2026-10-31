import fs from "node:fs";
import { parseSessionFile } from "./tree.js";
import { estimateTokens } from "./meter.js";
/**
 * Prunes and compacts a single Claude Code .jsonl session file safely.
 */
export async function pruneSessionFile(filePath, options = {}) {
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
    const prunedEvents = [];
    const totalEventsCount = tree.events.length;
    for (let index = 0; index < totalEventsCount; index++) {
        const event = tree.events[index];
        // 1. Evict dead branches / orphaned forks
        if (pruneDead && tree.deadBranchUuids.has(event.uuid)) {
            deadEventsRemoved++;
            continue;
        }
        // Clone event to avoid modifying in-memory originals
        const prunedEvent = JSON.parse(JSON.stringify(event));
        // Is this an older turn? (e.g. not in the latest 3 turns)
        const isHistoricalTurn = index < totalEventsCount - 3;
        // 2. Prune and truncate oversized tool outputs
        if (truncateTools) {
            if (prunedEvent.tool_result) {
                const truncated = truncateOutputPayload(prunedEvent.tool_result, maxToolChars);
                if (truncated.didTruncate) {
                    prunedEvent.tool_result = truncated.data;
                    toolOutputsTruncated++;
                }
            }
            // Check tool_result inside message.content array
            if (Array.isArray(prunedEvent.message?.content)) {
                prunedEvent.message.content = prunedEvent.message.content.map((block) => {
                    if (block.type === "tool_result") {
                        const rawContent = block.content || block.output;
                        if (rawContent) {
                            const res = truncateOutputPayload(rawContent, maxToolChars);
                            if (res.didTruncate) {
                                toolOutputsTruncated++;
                                if (block.content)
                                    block.content = res.data;
                                if (block.output)
                                    block.output = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
                            }
                        }
                    }
                    // 3. Compress historical extended thinking blocks
                    if (collapseThinking && isHistoricalTurn && (block.type === "thinking" || block.thinking)) {
                        const thinkingText = block.thinking || block.text || "";
                        if (thinkingText.length > 500) {
                            thinkingBlocksCompressed++;
                            const collapsed = `[claude-prune: historical thinking compressed (${Math.round(thinkingText.length / 3.8)} tokens saved)]`;
                            if (block.thinking)
                                block.thinking = collapsed;
                            if (block.text)
                                block.text = collapsed;
                        }
                    }
                    return block;
                });
            }
        }
        // 4. Compress top-level thinking if present on older turns
        if (collapseThinking && isHistoricalTurn && prunedEvent.thinking) {
            const thinkingStr = typeof prunedEvent.thinking === "string"
                ? prunedEvent.thinking
                : JSON.stringify(prunedEvent.thinking);
            if (thinkingStr.length > 500) {
                thinkingBlocksCompressed++;
                prunedEvent.thinking = "[claude-prune: historical thinking compressed]";
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
    let backupPath = null;
    // If dry-run, do not write to disk
    if (!options.dryRun) {
        // Create backup file if requested (default true)
        if (options.createBackup !== false) {
            backupPath = `${filePath}.bak.jsonl`;
            fs.copyFileSync(filePath, backupPath);
        }
        // Write pruned output using atomic temp file
        const tempPath = `${filePath}.tmp.${Date.now()}`;
        const outputLines = prunedEvents.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
        fs.writeFileSync(tempPath, outputLines, { encoding: "utf-8" });
        fs.renameSync(tempPath, filePath);
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
 * Truncates oversized string or object tool results while preserving head and tail.
 */
function truncateOutputPayload(data, maxChars) {
    if (!data)
        return { data, didTruncate: false };
    const isString = typeof data === "string";
    const str = isString ? data : JSON.stringify(data);
    if (str.length <= maxChars) {
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
export function restoreBackup(filePath) {
    const backupPath = filePath.endsWith(".bak.jsonl") ? filePath : `${filePath}.bak.jsonl`;
    const originalPath = backupPath.replace(/\.bak\.jsonl$/, "");
    if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, originalPath);
        return true;
    }
    return false;
}
