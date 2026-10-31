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
    const homeDir = os.homedir();
    return path.join(homeDir, ".claude");
}
/**
 * Returns the path to the Claude projects directory.
 */
export function getClaudeProjectsDir() {
    return path.join(getClaudeRootDir(), "projects");
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
 * Discovers all Claude Code session .jsonl files.
 */
export function discoverSessions(targetPath) {
    const sessions = [];
    // If user provided a specific file or directory
    if (targetPath) {
        const resolved = path.resolve(targetPath);
        if (!fs.existsSync(resolved)) {
            return [];
        }
        const stat = fs.statSync(resolved);
        if (stat.isFile() && resolved.endsWith(".jsonl")) {
            sessions.push({
                filePath: resolved,
                fileName: path.basename(resolved),
                sessionId: path.basename(resolved, ".jsonl"),
                projectFolder: path.basename(path.dirname(resolved)),
                projectDisplayName: decodeProjectName(path.basename(path.dirname(resolved))),
                fileSizeBytes: stat.size,
                lastModified: stat.mtime,
            });
            return sessions;
        }
        if (stat.isDirectory()) {
            return scanDirectoryForJsonl(resolved);
        }
    }
    // Scan default Claude projects directory
    const projectsDir = getClaudeProjectsDir();
    if (!fs.existsSync(projectsDir)) {
        return [];
    }
    return scanDirectoryForJsonl(projectsDir);
}
function scanDirectoryForJsonl(rootDir) {
    const results = [];
    try {
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(rootDir, entry.name);
            if (entry.isDirectory()) {
                try {
                    const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
                    for (const sub of subEntries) {
                        if (sub.isFile() && sub.name.endsWith(".jsonl") && !sub.name.endsWith(".bak.jsonl")) {
                            const subPath = path.join(fullPath, sub.name);
                            const stat = fs.statSync(subPath);
                            results.push({
                                filePath: subPath,
                                fileName: sub.name,
                                sessionId: path.basename(sub.name, ".jsonl"),
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
            else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".bak.jsonl")) {
                const stat = fs.statSync(fullPath);
                results.push({
                    filePath: fullPath,
                    fileName: entry.name,
                    sessionId: path.basename(entry.name, ".jsonl"),
                    projectFolder: path.basename(rootDir),
                    projectDisplayName: decodeProjectName(path.basename(rootDir)),
                    fileSizeBytes: stat.size,
                    lastModified: stat.mtime,
                });
            }
        }
    }
    catch {
        // ignore root directory read errors
    }
    // Sort by newest modified first
    return results.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}
