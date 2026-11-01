import path from "node:path";
import fs from "node:fs";
import { discoverSessions, getClaudeProjectsDir } from "./locator.js";
import { analyzeSession } from "./tree.js";
import { pruneSessionFile, restoreBackup } from "./pruner.js";
import { formatTokens, formatBytes, formatCurrency, estimateCacheReadCost } from "./meter.js";
import { startLocalDashboard } from "./server.js";
import type { SessionAnalysis } from "./types.js";

// Check if terminal natively supports UTF-8 and modern glyphs
const isModernTerminal = Boolean(
  process.env.WT_SESSION || // Windows Terminal
  process.env.TERM_PROGRAM || // VS Code, Hyper, iTerm
  process.env.LC_ALL?.toLowerCase().includes("utf-8") ||
  process.env.LANG?.toLowerCase().includes("utf-8") ||
  process.platform !== "win32" // macOS and Linux standard
);

// Color palette (ANSI)
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  bgCyan: "\x1b[46m\x1b[30m",
  bgGreen: "\x1b[42m\x1b[30m",
  bgRed: "\x1b[41m\x1b[37m",
};

// Adaptive Glyphs: Beautiful Unicode on modern terminals, bulletproof ASCII on standard PowerShell
const g = isModernTerminal
  ? {
      tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", div: "├", rdiv: "┤",
      bolt: "⚡",
      arrow: "👉",
      check: "✔",
      party: "🎉",
      chart: "📉",
      shield: "🛡️",
      bullet: "●",
      barFull: "█",
      barEmpty: "░",
    }
  : {
      tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", div: "+", rdiv: "+",
      bolt: "*",
      arrow: ">>",
      check: "[OK]",
      party: "*",
      chart: "(-)",
      shield: "[SHIELD]",
      bullet: "*",
      barFull: "=",
      barEmpty: "-",
    };

function renderBar(percent: number, width = 12): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `[${g.barFull.repeat(filled)}${g.barEmpty.repeat(empty)}]`;
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const command = args[0] || "scan";

  switch (command) {
    case "scan":
    case "audit":
      await handleScanCommand(args.slice(1));
      break;

    case "prune":
    case "clean":
      await handlePruneCommand(args.slice(1));
      break;

    case "watch":
      await handleWatchCommand(args.slice(1));
      break;

    case "app":
    case "ui":
    case "dashboard":
    case "gui":
      await handleAppCommand(args.slice(1));
      break;

    case "restore":
      handleRestoreCommand(args.slice(1));
      break;

    case "--help":
    case "-h":
    case "help":
      printHelp();
      break;

    case "--version":
    case "-v":
      console.log("claude-prune v0.1.0");
      break;

    default:
      console.log(`${c.red}Unknown command:${c.reset} ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function handleScanCommand(args: string[]): Promise<void> {
  printHeader();

  const targetPath = getArgValue(args, "--target", "-t");
  const sessions = discoverSessions(targetPath);

  if (sessions.length === 0) {
    console.log(`\n${c.yellow}No Claude Code sessions found.${c.reset}`);
    console.log(`Looked in: ${c.dim}${getClaudeProjectsDir()}${c.reset}\n`);
    console.log(`Tip: If your Claude Code is configured elsewhere, pass ${c.cyan}--target <path>${c.reset} or set ${c.cyan}CLAUDE_CONFIG_DIR${c.reset}.\n`);
    return;
  }

  process.stdout.write(`Analyzing ${c.bold}${sessions.length}${c.reset} sessions across Claude projects... `);

  const analyses: SessionAnalysis[] = [];
  let totalRawTokens = 0;
  let totalSavedTokens = 0;
  let totalSizeBytes = 0;

  for (const session of sessions) {
    try {
      const analysis = await analyzeSession(session.filePath, session.projectDisplayName);
      analyses.push(analysis);
      totalRawTokens += analysis.rawEstimatedTokens;
      totalSavedTokens += analysis.tokensSaved;
      totalSizeBytes += analysis.fileSizeBytes;
    } catch {
      // Ignore unreadable session
    }
  }

  console.log(`${c.green}${g.check} Done${c.reset}\n`);

  const totalSavingsPercent = totalRawTokens > 0 
    ? Math.round((totalSavedTokens / totalRawTokens) * 100) 
    : 0;

  const estimatedDollarsSaved = estimateCacheReadCost(totalSavedTokens, 20);

  const bar = renderBar(totalSavingsPercent, 14);
  const W = 68;
  const hLine = g.h.repeat(W);

  console.log(`${c.cyan}${g.tl}${hLine}${g.tr}${c.reset}`);
  console.log(`${c.cyan}${g.v}${c.reset}  ${c.bold}CACHE HEALTH & METRICS AUDIT${c.reset}${" ".repeat(W - 30)}${c.cyan}${g.v}${c.reset}`);
  console.log(`${c.cyan}${g.div}${hLine}${g.rdiv}${c.reset}`);
  console.log(`${c.cyan}${g.v}${c.reset}  ${c.dim}Total Session Files :${c.reset} ${c.bold}${sessions.length.toString().padEnd(4)}${c.reset} (${formatBytes(totalSizeBytes)})`.padEnd(W + 8) + `${c.cyan}${g.v}${c.reset}`);
  console.log(`${c.cyan}${g.v}${c.reset}  ${c.dim}Active Context Pool :${c.reset} ${formatTokens(totalRawTokens).padEnd(10)} tokens`.padEnd(W + 8) + `${c.cyan}${g.v}${c.reset}`);
  console.log(`${c.cyan}${g.v}${c.reset}  ${c.dim}Redundant Dead Weight:${c.reset} ${c.red}${c.bold}${formatTokens(totalSavedTokens).padEnd(10)}${c.reset} tokens ${c.yellow}${bar} ${totalSavingsPercent}%${c.reset}`.padEnd(W + 27) + `${c.cyan}${g.v}${c.reset}`);
  console.log(`${c.cyan}${g.v}${c.reset}${" ".repeat(W)}${c.cyan}${g.v}${c.reset}`);
  console.log(`${c.cyan}${g.v}${c.reset}  ${c.green}${g.chart} ${c.bold}Potential Cache Savings:${c.reset} ${c.bold}${formatTokens(totalSavedTokens * 20)}${c.reset} reads (${c.green}${formatCurrency(estimatedDollarsSaved)}${c.reset} saved)`.padEnd(W + 28) + `${c.cyan}${g.v}${c.reset}`);
  console.log(`${c.cyan}${g.bl}${hLine}${g.br}${c.reset}\n`);

  // Top Bloated Sessions
  console.log(`${c.bold}TOP SESSIONS WITH CACHE BLOAT:${c.reset}`);
  console.log(`${c.dim}${"-".repeat(70)}${c.reset}`);
  console.log(`  ${"PROJECT / SESSION".padEnd(32)} ${"TOKENS".padEnd(12)} ${"SAVINGS".padEnd(13)} ${"DEAD FORKS"}`);
  console.log(`${c.dim}${"-".repeat(70)}${c.reset}`);

  analyses.sort((a, b) => b.tokensSaved - a.tokensSaved);

  const displayLimit = Math.min(analyses.length, 7);
  for (let i = 0; i < displayLimit; i++) {
    const a = analyses[i];
    const projName = path.basename(a.projectName).slice(0, 14);
    const sessName = a.fileName.slice(0, 13);
    const displayName = `${projName} / ${sessName}`;

    const savingsColor = a.savingsPercent >= 70 ? c.green : a.savingsPercent >= 30 ? c.yellow : c.dim;
    const deadForkDisplay = a.deadBranchEvents > 0 
      ? `${c.red}${a.deadBranchEvents.toLocaleString()} dead${c.reset}` 
      : `${c.dim}0 clean${c.reset}`;

    console.log(
      `  ${displayName.padEnd(32)} ${formatTokens(a.rawEstimatedTokens).padEnd(12)} ${savingsColor}${a.savingsPercent}% (${formatTokens(a.tokensSaved)})${c.reset}`.padEnd(60) + ` ${deadForkDisplay}`
    );
  }

  console.log(`${c.dim}${"-".repeat(70)}${c.reset}\n`);

  console.log(`  ${c.cyan}${g.arrow}${c.reset} Run ${c.green}${c.bold}node bin/claude-prune.js prune --all${c.reset} to purge dead tokens across all sessions.`);
  console.log(`  ${c.dim}(Creates automatic .bak.jsonl backups. Revert anytime with 'restore')${c.reset}\n`);
}

async function handlePruneCommand(args: string[]): Promise<void> {
  const isDryRun = args.includes("--dry-run");
  const pruneAll = args.includes("--all") || args.includes("-a");
  const targetPath = getArgValue(args, "--target", "-t");
  const noBackup = args.includes("--no-backup");

  printHeader();

  if (isDryRun) {
    console.log(`  ${c.yellow}${c.bold}[SIMULATION MODE - DRY RUN]${c.reset} No files will be modified.\n`);
  }

  const sessions = discoverSessions(targetPath);

  if (sessions.length === 0) {
    console.log(`${c.yellow}No sessions found to prune.${c.reset}`);
    return;
  }

  const targetsToPrune = pruneAll ? sessions : [sessions[0]];
  console.log(`Targeting ${c.bold}${targetsToPrune.length}${c.reset} session(s):\n`);

  let totalTokensSaved = 0;
  let totalBytesSaved = 0;
  let totalDeadEvicted = 0;
  let totalLogsTruncated = 0;

  for (const session of targetsToPrune) {
    const shortName = `${path.basename(session.projectDisplayName)}/${session.fileName.slice(0, 18)}...`;
    process.stdout.write(`  ${c.dim}Pruning${c.reset} ${shortName.padEnd(36)} `);

    try {
      const res = await pruneSessionFile(session.filePath, {
        dryRun: isDryRun,
        createBackup: !noBackup,
      });

      totalTokensSaved += res.tokensSaved;
      totalBytesSaved += Math.max(0, res.originalSizeBytes - res.newSizeBytes);
      totalDeadEvicted += res.deadEventsRemoved;
      totalLogsTruncated += res.toolOutputsTruncated;

      if (res.tokensSaved > 0) {
        console.log(
          `${c.green}${g.check} -${res.savingsPercent}%${c.reset} ${c.dim}(spared ${formatTokens(res.tokensSaved)} tokens)${c.reset}`
        );
      } else {
        console.log(`${c.dim}(already optimal)${c.reset}`);
      }
    } catch (err: any) {
      console.log(`${c.red}Failed: ${err.message}${c.reset}`);
    }
  }

  console.log(`\n${c.bold}PRUNING RESULTS:${c.reset}`);
  console.log(`${c.dim}${"-".repeat(50)}${c.reset}`);
  console.log(`  ${g.check} Tokens Spared from Future Reads : ${c.bold}${c.green}${formatTokens(totalTokensSaved)}${c.reset}`);
  console.log(`  ${g.check} Dead Conversation Forks Evicted : ${c.bold}${totalDeadEvicted.toLocaleString()}${c.reset}`);
  console.log(`  ${g.check} Oversized Tool Logs Compacted   : ${c.bold}${totalLogsTruncated.toLocaleString()}${c.reset}`);
  console.log(`  ${g.check} Disk Space Reclaimed            : ${c.bold}${formatBytes(totalBytesSaved)}${c.reset}`);
  if (!noBackup && !isDryRun) {
    console.log(`  ${g.shield} Backup Status                   : ${c.dim}.bak.jsonl created${c.reset}`);
  }
  console.log(`${c.dim}${"-".repeat(50)}${c.reset}\n`);
}

async function handleAppCommand(args: string[]): Promise<void> {
  printHeader();

  const portStr = getArgValue(args, "--port", "-p");
  const port = portStr ? parseInt(portStr, 10) : 3847;
  const noOpen = args.includes("--no-open");

  try {
    const { url } = await startLocalDashboard({ port, openBrowser: !noOpen });
    console.log(`  ${c.green}${g.shield} Local Dashboard Running!${c.reset}`);
    console.log(`  ${c.bold}URL:${c.reset} ${c.cyan}${url}${c.reset}`);
    console.log(`  ${c.dim}🔒 Security: Strictly bound to 127.0.0.1 (Localhost only, zero external network calls)${c.reset}`);
    console.log(`\n  Auto-Shield is ${c.green}${c.bold}ACTIVE${c.reset}. Keeping your Claude sessions lean in real-time.`);
    console.log(`  ${c.dim}Press Ctrl+C to stop.${c.reset}\n`);
  } catch (err: any) {
    console.log(`  ${c.red}Failed to start local app server: ${err.message}${c.reset}`);
  }
}

async function handleWatchCommand(args: string[]): Promise<void> {
  printHeader();
  console.log(`  ${c.green}${g.shield} Background Cache Shield Active${c.reset}`);
  console.log(`  Monitoring active Claude Code sessions for cache bloat...`);
  console.log(`  ${c.dim}Press Ctrl+C to stop.${c.reset}\n`);

  const projectsDir = getClaudeProjectsDir();
  if (!fs.existsSync(projectsDir)) {
    console.log(`${c.red}Claude projects directory does not exist at:${c.reset} ${projectsDir}`);
    return;
  }

  let debounceTimer: NodeJS.Timeout | null = null;

  try {
    fs.watch(projectsDir, { recursive: true }, (_eventType, filename) => {
      if (filename && filename.endsWith(".jsonl") && !filename.endsWith(".bak.jsonl") && !filename.includes(".tmp.")) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            const sessions = discoverSessions();
            if (sessions.length > 0) {
              const latest = sessions[0];
              const timestamp = new Date().toLocaleTimeString();
              process.stdout.write(`\r  [${timestamp}] Active session updated: ${c.cyan}${latest.fileName.slice(0, 16)}${c.reset} `);
              const res = await pruneSessionFile(latest.filePath, { dryRun: false, createBackup: false });
              if (res.tokensSaved > 500) {
                console.log(`${c.green}${g.shield} Shielded! Spared ${formatTokens(res.tokensSaved)} cache tokens.${c.reset}`);
              } else {
                process.stdout.write(`${c.dim}(clean)${c.reset}\n`);
              }
            }
          } catch (err: any) {
            if (err.code === "EPERM" || err.code === "EBUSY") {
              process.stdout.write(`${c.dim}(busy, retrying)${c.reset}\n`);
              return;
            }
            console.error(`\n${c.red}Shield notice:${c.reset} ${err.message}`);
          }
        }, 2000);
      }
    });
  } catch (err: any) {
    console.log(`${c.red}Watcher error: ${err.message}${c.reset}`);
  }
}

function handleRestoreCommand(args: string[]): void {
  printHeader();
  const targetPath = getArgValue(args, "--target", "-t");
  const sessions = discoverSessions(targetPath);

  let restoredCount = 0;
  for (const session of sessions) {
    if (restoreBackup(session.filePath)) {
      console.log(`  ${c.green}${g.check} Restored:${c.reset} ${session.fileName} from backup`);
      restoredCount++;
    }
  }

  if (restoredCount === 0) {
    console.log(`  ${c.yellow}No .bak.jsonl backups found to restore.${c.reset}\n`);
  } else {
    console.log(`\n  ${c.green}${g.check} Successfully restored ${restoredCount} session(s).${c.reset}\n`);
  }
}

function printHeader(): void {
  console.log(`\n${c.cyan}${c.bold}======================================================================${c.reset}`);
  console.log(`  ${c.bold}${c.cyan}CLAUDE-PRUNE${c.reset} ${c.dim}:: Intelligent Session Garbage Collector & Cache Shield${c.reset}`);
  console.log(`${c.cyan}${c.bold}======================================================================${c.reset}\n`);
}

function getArgValue(args: string[], flag: string, shortFlag?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag || (shortFlag && args[i] === shortFlag)) {
      return args[i + 1];
    }
    if (args[i].startsWith(`${flag}=`)) {
      return args[i].slice(flag.length + 1);
    }
  }
  return undefined;
}

function printHelp(): void {
  printHeader();
  console.log(`USAGE:
  $ node bin/claude-prune.js <command> [options]

COMMANDS:
  scan     Audit all Claude Code sessions for dead branches and cache bloat (default)
  prune    Safely compact active sessions, evicting dead forks and truncating logs
  app      Launch the local real-time desktop dashboard (http://127.0.0.1:3847)
  watch    Real-time background daemon to keep active sessions under token limits
  restore  Revert changes using automatic .bak.jsonl backups

OPTIONS:
  --all, -a       Prune all sessions (default prunes only the most recent)
  --dry-run       Simulate pruning without modifying files
  --no-backup     Do not create .bak.jsonl backup files
  --target, -t <p> Path to a specific project folder or .jsonl file
  -v, --version   Show version
  -h, --help      Show help
`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts")) {
  runCli().catch((err) => {
    console.error(`\x1b[31mError:\x1b[0m`, err);
    process.exit(1);
  });
}
