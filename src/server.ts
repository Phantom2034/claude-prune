import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { discoverSessions, getClaudeProjectsDir } from "./locator.js";
import { analyzeSession } from "./tree.js";
import { pruneSessionFile, restoreBackup } from "./pruner.js";
import { formatTokens, formatBytes, formatCurrency, estimateCacheReadCost } from "./meter.js";

// STRICT LOCALHOST BINDING - Never exposes to external network
const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 3847;

export interface ServerOptions {
  port?: number;
  openBrowser?: boolean;
}

export function startLocalDashboard(options: ServerOptions = {}): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve, reject) => {
    let autoShieldEnabled = true;
    let sseClients: http.ServerResponse[] = [];
    let fileWatcher: fs.FSWatcher | null = null;
    let cachedStats: any = null;
    let isAnalyzing = false;

    // Broadcast real-time event to connected browser tabs
    function broadcast(type: string, data: any) {
      const payload = `data: ${JSON.stringify({ type, data, timestamp: new Date().toLocaleTimeString() })}\n\n`;
      sseClients.forEach((client) => {
        try {
          client.write(payload);
        } catch {
          // ignore broken pipe
        }
      });
    }

    async function getOrComputeStats(forceRefresh = false) {
      if (cachedStats && !forceRefresh) {
        return cachedStats;
      }
      if (isAnalyzing && cachedStats) return cachedStats;

      isAnalyzing = true;
      try {
        const sessions = discoverSessions();
        const analyses = [];
        let totalRaw = 0;
        let totalSaved = 0;
        let totalSize = 0;
        let totalDead = 0;

        for (const s of sessions) {
          try {
            const a = await analyzeSession(s.filePath, s.projectDisplayName);
            analyses.push(a);
            totalRaw += a.rawEstimatedTokens;
            totalSaved += a.tokensSaved;
            totalSize += a.fileSizeBytes;
            totalDead += a.deadBranchEvents;
          } catch (err: any) {
            console.error(`Warning: Skipping session ${s.fileName}:`, err.message);
          }
        }

        cachedStats = {
          sessionsCount: analyses.length,
          totalSizeBytes: totalSize,
          totalRawTokens: totalRaw,
          totalSavedTokens: totalSaved,
          totalDeadForks: totalDead,
          estimatedDollarsSaved: estimateCacheReadCost(totalSaved, 20),
          autoShieldEnabled,
          sessions: analyses,
        };
        return cachedStats;
      } finally {
        isAnalyzing = false;
      }
    }

    // Initialize local file watcher for live shield
    function initWatcher() {
      const projectsDir = getClaudeProjectsDir();
      if (!fs.existsSync(projectsDir)) return;

      let debounceTimer: NodeJS.Timeout | null = null;
      try {
        fileWatcher = fs.watch(projectsDir, { recursive: true }, (_eventType, filename) => {
          if (filename && filename.endsWith(".jsonl") && !filename.endsWith(".bak.jsonl") && !filename.includes(".tmp.")) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
              if (!autoShieldEnabled) return;
              const sessions = discoverSessions();
              if (sessions.length > 0) {
                const latest = sessions[0];
                const res = await pruneSessionFile(latest.filePath, { dryRun: false, createBackup: false });
                if (res.tokensSaved > 0) {
                  await getOrComputeStats(true); // invalidate cache
                  broadcast("shield_event", {
                    project: latest.projectDisplayName,
                    file: latest.fileName,
                    tokensSaved: res.tokensSaved,
                    deadForks: res.deadEventsRemoved,
                    logsTruncated: res.toolOutputsTruncated,
                    message: `Auto-shielded ${latest.fileName.slice(0, 14)}: Spared ${formatTokens(res.tokensSaved)} tokens`,
                  });
                }
              }
            }, 1200);
          }
        });
      } catch (err: any) {
        console.error("Watcher init error:", err.message);
      }
    }

    initWatcher();

    const server = http.createServer(async (req, res) => {
      // SECURITY GUARD: Enforce strictly local requests
      const host = req.headers.host || "";
      if (!host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: Localhost requests only.");
        return;
      }

      // Route: SSE Stream for real-time live events
      if (req.url === "/api/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write("data: {\"type\":\"connected\"}\n\n");
        sseClients.push(res);
        req.on("close", () => {
          sseClients = sseClients.filter((c) => c !== res);
        });
        return;
      }

      // Route: API Stats Audit
      if (req.url?.startsWith("/api/stats") && req.method === "GET") {
        try {
          const force = req.url.includes("refresh=true");
          const stats = await getOrComputeStats(force);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(stats));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Route: API Prune Single or All
      if (req.url?.startsWith("/api/prune") && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            const pruneAll = parsed.all === true;
            const targetPath = parsed.filePath;

            const sessions = discoverSessions(targetPath);
            const targets = pruneAll ? sessions : targetPath ? sessions : [sessions[0]];

            let sparedTotal = 0;
            let deadTotal = 0;
            let logsTruncated = 0;

            for (const sess of targets) {
              const res = await pruneSessionFile(sess.filePath, { createBackup: true });
              sparedTotal += res.tokensSaved;
              deadTotal += res.deadEventsRemoved;
              logsTruncated += res.toolOutputsTruncated;
            }

            // Invalidate cached stats
            await getOrComputeStats(true);

            broadcast("action_complete", {
              action: "prune",
              sparedTotal,
              deadTotal,
              logsTruncated,
              message: `Purged ${deadTotal.toLocaleString()} dead forks, compacted ${logsTruncated} logs, spared ${formatTokens(sparedTotal)} tokens`,
            });

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, sparedTotal, deadTotal, logsTruncated }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // Route: API Toggle Auto-Shield
      if (req.url === "/api/shield/toggle" && req.method === "POST") {
        autoShieldEnabled = !autoShieldEnabled;
        broadcast("shield_toggled", { enabled: autoShieldEnabled });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ enabled: autoShieldEnabled }));
        return;
      }

      // Route: API Restore
      if (req.url === "/api/restore" && req.method === "POST") {
        const sessions = discoverSessions();
        let restoredCount = 0;
        for (const s of sessions) {
          if (restoreBackup(s.filePath)) restoredCount++;
        }
        await getOrComputeStats(true);
        broadcast("action_complete", {
          action: "restore",
          restoredCount,
          message: `Restored ${restoredCount} sessions from .bak.jsonl backups`,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, restoredCount }));
        return;
      }

      // Route: Serve Embedded Standalone Dashboard (Zero External CDNs/Fonts)
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getDashboardHtml());
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    const port = options.port || DEFAULT_PORT;
    server.listen(port, LOCAL_HOST, () => {
      const url = `http://${LOCAL_HOST}:${port}`;
      if (options.openBrowser !== false) {
        openBrowser(url);
      }
      resolve({ server, url });
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        server.listen(port + 1, LOCAL_HOST, () => {
          const url = `http://${LOCAL_HOST}:${port + 1}`;
          if (options.openBrowser !== false) openBrowser(url);
          resolve({ server, url });
        });
      } else {
        reject(err);
      }
    });
  });
}

function openBrowser(url: string) {
  const start = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${start} ${url}`);
}

/**
 * 100% Offline, Self-Contained Dark-Mode Dashboard HTML/CSS/JS.
 * Contains ZERO external fonts, scripts, or analytics.
 */
function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude-Prune :: Local Cache Shield</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #111827;
      --card-border: #1f293d;
      --text: #f3f4f6;
      --text-dim: #9ca3af;
      --cyan: #06b6d4;
      --cyan-glow: rgba(6, 182, 212, 0.25);
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.25);
      --red: #ef4444;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --mono: "SF Mono", Consolas, "Liberation Mono", Menlo, Courier, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: rgba(17, 24, 39, 0.85);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--card-border);
      padding: 16px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-logo {
      background: linear-gradient(135deg, var(--cyan), #3b82f6);
      width: 36px;
      height: 36px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      color: #000;
      box-shadow: 0 0 15px var(--cyan-glow);
    }
    .brand-title {
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .brand-badge {
      font-size: 0.75rem;
      background: rgba(16, 185, 129, 0.15);
      color: var(--green);
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 3px 8px;
      border-radius: 999px;
      font-weight: 600;
    }
    .security-badge {
      font-size: 0.75rem;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      padding: 6px 12px;
      border-radius: 6px;
      color: var(--text-dim);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    main {
      flex: 1;
      padding: 32px;
      max-width: 1200px;
      margin: 0 auto;
      width: 100%;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 22px;
      position: relative;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .stat-card:hover {
      border-color: rgba(6, 182, 212, 0.4);
    }
    .stat-label {
      font-size: 0.8rem;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .stat-value {
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -1px;
      font-family: var(--mono);
    }
    .stat-sub {
      font-size: 0.8rem;
      color: var(--green);
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 32px;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .card-title {
      font-size: 1.1rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn {
      background: var(--card-border);
      color: var(--text);
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--cyan), #2563eb);
      color: #fff;
      border: none;
      box-shadow: 0 0 15px var(--cyan-glow);
    }
    .btn-primary:hover {
      opacity: 0.9;
      transform: translateY(-1px);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th {
      text-align: left;
      padding: 12px;
      color: var(--text-dim);
      font-weight: 600;
      border-bottom: 1px solid var(--card-border);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    td {
      padding: 14px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      font-family: var(--mono);
      font-size: 0.85rem;
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-clean { background: rgba(16, 185, 129, 0.15); color: var(--green); }
    .badge-bloated { background: rgba(239, 68, 68, 0.15); color: var(--red); }
    .progress-bar-bg {
      background: rgba(255, 255, 255, 0.08);
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      width: 100px;
      display: inline-block;
      vertical-align: middle;
      margin-right: 8px;
    }
    .progress-bar-fill {
      background: linear-gradient(90deg, var(--green), var(--cyan));
      height: 100%;
      border-radius: 3px;
    }
    .feed {
      background: #070a11;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 16px;
      font-family: var(--mono);
      font-size: 0.8rem;
      max-height: 200px;
      overflow-y: auto;
    }
    .feed-item {
      padding: 4px 0;
      display: flex;
      gap: 12px;
      color: var(--text-dim);
    }
    .feed-time { color: var(--cyan); }
    .feed-msg { color: var(--text); }
    .toggle-shield {
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    /* Modal Styles */
    .modal-backdrop {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .modal-box {
      background: var(--card);
      border: 1px solid var(--cyan);
      border-radius: 14px;
      padding: 28px;
      max-width: 600px;
      width: 90%;
      box-shadow: 0 0 30px var(--cyan-glow);
    }
    .modal-title {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .diff-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin: 20px 0;
    }
    .diff-card {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 16px;
    }
    .diff-card-title {
      font-size: 0.8rem;
      color: var(--text-dim);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    .diff-stat {
      margin-bottom: 10px;
    }
    .diff-stat-lbl { font-size: 0.75rem; color: var(--text-dim); }
    .diff-stat-val { font-size: 1.1rem; font-weight: 700; font-family: var(--mono); }
    .savings-highlight {
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 20px;
      text-align: center;
    }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="brand-logo">CP</div>
      <div>
        <div class="brand-title">claude-prune</div>
        <div style="font-size: 0.75rem; color: var(--text-dim);">Cache Shield & Session Optimizer</div>
      </div>
      <div class="brand-badge">v0.1.0</div>
    </div>

    <div style="display: flex; align-items: center; gap: 16px;">
      <div class="toggle-shield" onclick="toggleShield()">
        <div class="pulse-dot" id="shieldDot"></div>
        <span id="shieldStatus" style="font-size: 0.85rem; font-weight: 600;">Auto-Shield: ACTIVE</span>
      </div>
      <div class="security-badge">
        <span>🔒</span>
        <span>Local Only (127.0.0.1)</span>
      </div>
    </div>
  </header>

  <main>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Tokens Spared</div>
        <div class="stat-value" id="valSaved" style="color: var(--cyan);">--</div>
        <div class="stat-sub">Spared from repetitive cache reads</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Dead Conversation Forks</div>
        <div class="stat-value" id="valForks" style="color: #ec4899;">--</div>
        <div class="stat-sub">Purged unreachable subtrees</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Estimated Spend Saved</div>
        <div class="stat-value" id="valCost" style="color: var(--green);">--</div>
        <div class="stat-sub">Anthropic cache pricing model</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Claude Sessions</div>
        <div class="stat-value" id="valSessions">--</div>
        <div class="stat-sub" id="valDiskSpace">Scanning disk...</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <span>Active Claude Code Sessions</span>
        </div>
        <div style="display: flex; gap: 10px;">
          <button class="btn" onclick="restoreBackups()">↺ Restore Backup</button>
          <button class="btn btn-primary" onclick="pruneAll()">⚡ Purge All Bloat</button>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Project / Directory</th>
            <th>Session UUID</th>
            <th>Raw Context</th>
            <th>Pruning Savings</th>
            <th>Dead Forks</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="sessionTableBody">
          <tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: 30px;">Loading sessions...</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Live Cache Shield Feed</div>
        <span style="font-size: 0.8rem; color: var(--text-dim);">Listening to ~/.claude/projects/</span>
      </div>
      <div class="feed" id="eventFeed">
        <div class="feed-item">
          <span class="feed-time">SYSTEM</span>
          <span class="feed-msg">Local shield active. Watching for active Claude Code session updates...</span>
        </div>
      </div>
    </div>
  </main>

  <!-- Before & After Diff Inspector Modal -->
  <div class="modal-backdrop" id="diffModal">
    <div class="modal-box">
      <div class="modal-title">
        <span id="modalSessionTitle">Session Optimization Diff</span>
        <span style="cursor: pointer; color: var(--text-dim);" onclick="closeModal()">✕</span>
      </div>
      <div style="font-size: 0.8rem; color: var(--text-dim);" id="modalSessionSubtitle">Project / File</div>

      <div class="diff-grid">
        <div class="diff-card">
          <div class="diff-card-title" style="color: var(--red);">🔴 Before Pruning</div>
          <div class="diff-stat">
            <div class="diff-stat-lbl">Context Tokens Sent Per Turn</div>
            <div class="diff-stat-val" id="modalTokensBefore">--</div>
          </div>
          <div class="diff-stat">
            <div class="diff-stat-lbl">JSONL Log Size on Disk</div>
            <div class="diff-stat-val" id="modalSizeBefore">--</div>
          </div>
          <div class="diff-stat">
            <div class="diff-stat-lbl">Dead Branches / Forks</div>
            <div class="diff-stat-val" id="modalDeadBefore" style="color: var(--red);">--</div>
          </div>
        </div>

        <div class="diff-card" style="border-color: rgba(16, 185, 129, 0.4);">
          <div class="diff-card-title" style="color: var(--green);">🟢 After Pruning</div>
          <div class="diff-stat">
            <div class="diff-stat-lbl">Context Tokens Sent Per Turn</div>
            <div class="diff-stat-val" id="modalTokensAfter" style="color: var(--green);">--</div>
          </div>
          <div class="diff-stat">
            <div class="diff-stat-lbl">Optimized Log Size on Disk</div>
            <div class="diff-stat-val" id="modalSizeAfter" style="color: var(--green);">--</div>
          </div>
          <div class="diff-stat">
            <div class="diff-stat-lbl">Dead Branches / Forks</div>
            <div class="diff-stat-val" style="color: var(--green);">0 clean</div>
          </div>
        </div>
      </div>

      <div class="savings-highlight">
        <div style="font-size: 0.85rem; color: var(--green); font-weight: 700;" id="modalSavingsHighlight">
          📉 Saves ~X tokens on every future Claude turn
        </div>
        <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 4px;">
          Truncates oversized terminal logs and evicts dead prompt forks while keeping 100% of active conversation.
        </div>
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 10px;">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn btn-primary" id="modalPruneBtn">⚡ Prune Now</button>
      </div>
    </div>
  </div>

  <script>
    let currentSessions = [];
    let selectedSessionIdx = null;

    async function loadStats(refresh = false) {
      try {
        const res = await fetch('/api/stats' + (refresh ? '?refresh=true' : ''));
        if (!res.ok) {
          throw new Error('Server returned HTTP ' + res.status);
        }
        const data = await res.json();
        if (data.error) {
          throw new Error(data.error);
        }
        currentSessions = data.sessions || [];
        renderDashboard(data);
      } catch (err) {
        console.error("Failed to load stats:", err);
        appendFeed("Error loading stats: " + err.message);
        document.getElementById('valDiskSpace').textContent = 'Error loading stats';
      }
    }

    function formatNumber(num) {
      if (!num || isNaN(num)) return '0';
      if (num >= 1000000000) return (num / 1000000000).toFixed(2) + 'B';
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
      return Number(num).toLocaleString();
    }

    function formatBytes(bytes) {
      if (!bytes || isNaN(bytes)) return '0 B';
      if (bytes >= 1024*1024*1024) return (bytes / (1024*1024*1024)).toFixed(1) + ' GB';
      if (bytes >= 1024*1024) return (bytes / (1024*1024)).toFixed(1) + ' MB';
      if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return bytes + ' B';
    }

    function renderDashboard(data) {
      document.getElementById('valSaved').textContent = formatNumber(data.totalSavedTokens || 0);
      document.getElementById('valForks').textContent = (data.totalDeadForks || 0).toLocaleString();
      document.getElementById('valCost').textContent = '$' + (data.estimatedDollarsSaved || 0).toFixed(2);
      document.getElementById('valSessions').textContent = data.sessionsCount || 0;
      document.getElementById('valDiskSpace').textContent = formatBytes(data.totalSizeBytes || 0) + ' log storage';

      const tbody = document.getElementById('sessionTableBody');
      const sessions = data.sessions || [];
      if (sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: 30px;">All sessions are clean! No bloated sessions found.</td></tr>';
        return;
      }

      tbody.innerHTML = sessions.map((s, idx) => {
        const isOptimal = (s.tokensSaved || 0) === 0;
        const statusBadge = isOptimal 
          ? '<span class="badge badge-clean">OPTIMAL</span>' 
          : '<span class="badge badge-bloated">NEEDS PRUNING</span>';
        
        return \`
          <tr>
            <td style="font-weight: 600; color: #fff;">\${escapeHtml(s.projectName || 'default')}</td>
            <td style="color: var(--text-dim);">\${(s.fileName || '').slice(0, 16)}...</td>
            <td>\${formatNumber(s.rawEstimatedTokens || 0)}</td>
            <td>
              <div class="progress-bar-bg">
                <div class="progress-bar-fill" style="width: \${s.savingsPercent || 0}%"></div>
              </div>
              \${s.savingsPercent || 0}%
            </td>
            <td style="color: \${(s.deadBranchEvents || 0) > 0 ? 'var(--red)' : 'var(--text-dim)'}">\${(s.deadBranchEvents || 0).toLocaleString()}</td>
            <td>\${statusBadge}</td>
            <td>
              <button class="btn" style="padding: 4px 8px; font-size: 0.75rem; margin-right: 4px;" onclick="openDiffModal(\${idx})">
                Inspect Diff
              </button>
              \${!isOptimal ? \`
              <button class="btn btn-primary" style="padding: 4px 10px; font-size: 0.75rem;" onclick="pruneByIndex(\${idx})">
                Prune
              </button>\` : \`
              <button class="btn" style="padding: 4px 10px; font-size: 0.75rem; opacity: 0.5; cursor: default;">
                Optimal
              </button>\`}
            </td>
          </tr>
        \`;
      }).join('');
    }

    function openDiffModal(idx) {
      selectedSessionIdx = idx;
      const s = currentSessions[idx];
      if (!s) return;

      document.getElementById('modalSessionTitle').textContent = s.fileName;
      document.getElementById('modalSessionSubtitle').textContent = s.projectName;

      document.getElementById('modalTokensBefore').textContent = formatNumber(s.rawEstimatedTokens) + ' tokens';
      document.getElementById('modalSizeBefore').textContent = formatBytes(s.fileSizeBytes);
      document.getElementById('modalDeadBefore').textContent = s.deadBranchEvents.toLocaleString() + ' dead';

      const estimatedNewSize = Math.round(s.fileSizeBytes * (1 - s.savingsPercent / 100));
      document.getElementById('modalTokensAfter').textContent = formatNumber(s.prunedEstimatedTokens) + ' tokens';
      document.getElementById('modalSizeAfter').textContent = formatBytes(estimatedNewSize);

      document.getElementById('modalSavingsHighlight').textContent = 
        \`📉 Saves \${formatNumber(s.tokensSaved)} tokens (-\${s.savingsPercent}%) on every subsequent Claude turn!\`;

      const pruneBtn = document.getElementById('modalPruneBtn');
      pruneBtn.onclick = () => {
        closeModal();
        pruneByIndex(idx);
      };

      document.getElementById('diffModal').style.display = 'flex';
    }

    function closeModal() {
      document.getElementById('diffModal').style.display = 'none';
    }

    function escapeHtml(str) {
      return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function pruneAll() {
      appendFeed('Purging all sessions across projects...');
      try {
        const res = await fetch('/api/prune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
        const result = await res.json();
        appendFeed('✓ Prune complete: Spared ' + formatNumber(result.sparedTotal) + ' tokens, evicted ' + result.deadTotal + ' dead forks');
        loadStats(true);
      } catch (err) {
        appendFeed('Error pruning: ' + err.message);
      }
    }

    async function pruneByIndex(idx) {
      const target = currentSessions[idx];
      if (!target) return;
      appendFeed('Pruning session: ' + target.fileName);
      try {
        await fetch('/api/prune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: target.filePath }) });
        loadStats(true);
      } catch (err) {
        appendFeed('Error: ' + err.message);
      }
    }

    async function restoreBackups() {
      if (!confirm('Revert all pruned sessions using their .bak.jsonl backups?')) return;
      appendFeed('Restoring backups...');
      try {
        const res = await fetch('/api/restore', { method: 'POST' });
        const result = await res.json();
        appendFeed('✓ Restored ' + result.restoredCount + ' sessions from backup');
        loadStats(true);
      } catch (err) {
        appendFeed('Error restoring: ' + err.message);
      }
    }

    async function toggleShield() {
      try {
        const res = await fetch('/api/shield/toggle', { method: 'POST' });
        const data = await res.json();
        updateShieldUI(data.enabled);
      } catch (err) {
        console.error(err);
      }
    }

    function updateShieldUI(enabled) {
      const dot = document.getElementById('shieldDot');
      const text = document.getElementById('shieldStatus');
      if (enabled) {
        dot.style.background = 'var(--green)';
        dot.style.boxShadow = '0 0 8px var(--green)';
        text.textContent = 'Auto-Shield: ACTIVE';
      } else {
        dot.style.background = 'var(--text-dim)';
        dot.style.boxShadow = 'none';
        text.textContent = 'Auto-Shield: PAUSED';
      }
    }

    function appendFeed(msg) {
      const feed = document.getElementById('eventFeed');
      if (!feed) return;
      const item = document.createElement('div');
      item.className = 'feed-item';
      const time = new Date().toLocaleTimeString();
      item.innerHTML = '<span class="feed-time">' + time + '</span><span class="feed-msg">' + escapeHtml(msg) + '</span>';
      feed.prepend(item);
    }

    // Connect Server-Sent Events (SSE) for Real-Time Live Watcher
    try {
      const sse = new EventSource('/api/stream');
      sse.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === 'shield_event') {
            appendFeed('🛡️ ' + payload.data.message);
            loadStats(true);
          } else if (payload.type === 'action_complete') {
            appendFeed('✓ ' + payload.data.message);
            loadStats(true);
          } else if (payload.type === 'shield_toggled') {
            updateShieldUI(payload.data.enabled);
          }
        } catch (err) {}
      };
    } catch (e) {}

    // Initial load
    loadStats();
  </script>
</body>
</html>`;
}
