import fs from "node:fs";
import path from "node:path";
import os from "node:os";
/**
 * Returns the resolved root Claude Code configuration directory.
 */
export function getClaudeRootDir() {
    if (process.env.CLAUDE_CONFIG_DIR) {
        return path.resolve(process.env.CLAUDE_CONFIG_DIR);
    }
    return path.join(os.homedir(), ".claude");
}
/**
 * Returns the path to the Claude projects directory.
 */
export function getClaudeProjectsDir() {
    return path.join(getClaudeRootDir(), "projects");
}
/**
 * Returns the resolved root Codex CLI configuration directory.
 */
export function getCodexRootDir() {
    if (process.env.CODEX_HOME) {
        return path.resolve(process.env.CODEX_HOME);
    }
    return path.join(os.homedir(), ".codex");
}
/**
 * Returns the path to the Codex sessions directory.
 */
export function getCodexSessionsDir() {
    return path.join(getCodexRootDir(), "sessions");
}
/**
 * Decodes the slugified Claude project directory name into a human-readable path.
 * e.g., "-Users-you-code-my-app" -> "/Users/you/code/my-app"
 * or "C--Users-you-code" -> "C:\Users\you\code"
 */
export function decodeProjectName(folderName) {
    if (folderName.startsWith("C--") || folderName.match(/^[A-Za-z]--/)) {
        const drive = folderName[0];
        const rest = folderName.slice(3).replace(/-/g, path.sep);
        return `${drive}:${path.sep}${rest}`;
    }
    return folderName.replace(/^-/, path.sep).replace(/-/g, path.sep);
}
/**
 * Discovers sessions across Claude Code and Codex CLI.
 */
export function discoverSessions(targetPath, filterAgent) {
    const sessions = [];
    // If user provided a specific file or directory
    if (targetPath) {
        const resolved = path.resolve(targetPath);
        if (!fs.existsSync(resolved)) {
            return [];
        }
        const stat = fs.statSync(resolved);
        if (stat.isFile() && resolved.endsWith(".jsonl")) {
            const isCodex = resolved.toLowerCase().includes(".codex") || path.basename(resolved).startsWith("rollout-");
            const agentType = isCodex ? "codex" : "claude";
            sessions.push({
                filePath: resolved,
                fileName: path.basename(resolved),
                sessionId: path.basename(resolved, ".jsonl"),
                agentType,
                projectFolder: path.basename(path.dirname(resolved)),
                projectDisplayName: isCodex ? `Codex Thread (${path.basename(resolved, ".jsonl")})` : decodeProjectName(path.basename(path.dirname(resolved))),
                fileSizeBytes: stat.size,
                lastModified: stat.mtime,
            });
            return sessions;
        }
        if (stat.isDirectory()) {
            return scanDirectoryForJsonl(resolved, "claude");
        }
    }
    // 1. Scan Claude Code projects
    if (!filterAgent || filterAgent === "claude") {
        const claudeDir = getClaudeProjectsDir();
        if (fs.existsSync(claudeDir)) {
            sessions.push(...scanClaudeDirectory(claudeDir));
        }
    }
    // 2. Scan Codex CLI sessions
    if (!filterAgent || filterAgent === "codex") {
        const codexDir = getCodexSessionsDir();
        if (fs.existsSync(codexDir)) {
            sessions.push(...scanCodexDirectory(codexDir));
        }
    }
    // Sort by newest modified first
    return sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}
function scanClaudeDirectory(rootDir) {
    const results = [];
    try {
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(rootDir, entry.name);
            if (entry.isDirectory()) {
                try {
                    const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
                    for (const sub of subEntries) {
                        if (sub.isFile() && sub.name.endsWith(".jsonl") && !sub.name.endsWith(".bak.jsonl") && !sub.name.includes(".tmp.")) {
                            const subPath = path.join(fullPath, sub.name);
                            const stat = fs.statSync(subPath);
                            results.push({
                                filePath: subPath,
                                fileName: sub.name,
                                sessionId: path.basename(sub.name, ".jsonl"),
                                agentType: "claude",
                                projectFolder: entry.name,
                                projectDisplayName: decodeProjectName(entry.name),
                                fileSizeBytes: stat.size,
                                lastModified: stat.mtime,
                            });
                        }
                    }
                }
                catch {
                    // ignore directory permission errors
                }
            }
            else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".bak.jsonl") && !entry.name.includes(".tmp.")) {
                const stat = fs.statSync(fullPath);
                results.push({
                    filePath: fullPath,
                    fileName: entry.name,
                    sessionId: path.basename(entry.name, ".jsonl"),
                    agentType: "claude",
                    projectFolder: path.basename(rootDir),
                    projectDisplayName: decodeProjectName(path.basename(rootDir)),
                    fileSizeBytes: stat.size,
                    lastModified: stat.mtime,
                });
            }
        }
    }
    catch {
        // ignore read error
    }
    return results;
}
/**
 * Scans Codex CLI sessions folder (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 */
function scanCodexDirectory(rootDir) {
    const results = [];
    function walk(currentDir, depth = 0) {
        if (depth > 5)
            return;
        try {
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath, depth + 1);
                }
                else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".bak.jsonl") && !entry.name.includes(".tmp.")) {
                    const stat = fs.statSync(fullPath);
                    const relativeDate = path.relative(rootDir, currentDir).replace(/\\/g, "/");
                    results.push({
                        filePath: fullPath,
                        fileName: entry.name,
                        sessionId: path.basename(entry.name, ".jsonl").replace(/^rollout-/, ""),
                        agentType: "codex",
                        projectFolder: `codex/${relativeDate || "sessions"}`,
                        projectDisplayName: `Codex (${relativeDate || "session"})`,
                        fileSizeBytes: stat.size,
                        lastModified: stat.mtime,
                    });
                }
            }
        }
        catch {
            // ignore
        }
    }
    walk(rootDir);
    return results;
}
function scanDirectoryForJsonl(rootDir, defaultAgent = "claude") {
    const results = [];
    try {
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(rootDir, entry.name);
            if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".bak.jsonl") && !entry.name.includes(".tmp.")) {
                const stat = fs.statSync(fullPath);
                const isCodex = entry.name.startsWith("rollout-");
                results.push({
                    filePath: fullPath,
                    fileName: entry.name,
                    sessionId: path.basename(entry.name, ".jsonl"),
                    agentType: isCodex ? "codex" : defaultAgent,
                    projectFolder: path.basename(rootDir),
                    projectDisplayName: isCodex ? `Codex (${path.basename(rootDir)})` : decodeProjectName(path.basename(rootDir)),
                    fileSizeBytes: stat.size,
                    lastModified: stat.mtime,
                });
            }
        }
    }
    catch { }
    return results;
}
