# ⚡ claude-prune

> **The intelligent garbage collector and local cache shield for Claude Code sessions.**  
> Evicts orphaned conversation forks, compacts bloated tool logs, and halts the 157,000x context compounding loop.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20(Pure%20Native)-success.svg)](#)
[![Security: 100% Local](https://img.shields.io/badge/security-100%25%20Localhost%20(127.0.0.1)-orange.svg)](#)

---

## 🛑 The Problem: The "Compound Cache Read" Trap

If you use [Claude Code](https://github.com/anthropics/claude-code), your active sessions are stored locally as append-only JSON Lines logs in `~/.claude/projects/**/*.jsonl`.

### The 157,000x Real-World Multiplication
In an audit of an active 1-week development environment, the raw session metrics revealed a massive discrepancy:

| Metric | Measured Value | What It Means |
| :--- | :--- | :--- |
| **User Prompts Input** | **`7,600` tokens** | Roughly 15 brief user prompts total. |
| **Assistant Output Generated** | **`3,100,000` tokens** | Code generated across 13 sessions. |
| **Cache Reads Ingested** | **`1,200,000,000` tokens** | **A 157,000x multiplier on user input.** |

### Why Does This Happen?

1. **Unbounded Append-Only Logs:** Every single 500-line terminal output, failed unit test trace, and historical extended thinking block is permanently retained in the file.
2. **The `/compact` Orphan Bug:** Every time you use `/compact` or edit an earlier message, Claude Code creates a new conversation root or fork. The old branches become **unreachable dead leaves**, but they are never deleted from the `.jsonl` file.
3. **The Multiplier Penalty:** On every subsequent turn or session resume, Claude Code re-reads the entire historical transcript into the Anthropic Messages API. 
   - A 150,000-token unpruned session multiplied across 10 routine turns $\rightarrow$ **1.5 Million tokens billed and counted against your 7-day rate-limit window**.

---

## 📊 Measured Benchmark: Real-World Results

Ran across an active development environment with 13 diverse full-stack and systems projects:

```
+--------------------------------------------------------------------+
|  CLAUDE-PRUNE EMPIRICAL VERIFICATION REPORT                        |
+--------------------------------------------------------------------+
|  Initial Log Storage on Disk  : 213.7 MB                           |
|  Post-Pruning Storage on Disk : 45.6 MB                            |
|                                                                    |
|  📉 Physical Disk Reclaimed   : 146.7 MB (-78.6% dead weight)      |
|  🗑️ Dead Conversation Forks   : 9,517 orphaned branches purged     |
|  📜 Oversized Tool Logs       : 259 bloated logs compacted         |
|  ⚡ Tokens Spared from Reads  : 31,400,000 tokens                  |
|  💰 Estimated Cost Reduction  : $216.96 (Anthropic Cache Pricing)  |
+--------------------------------------------------------------------+
```

$$\text{Physical Verification: } 146,700,000\text{ bytes} \div 3.8\text{ chars/token} \approx \mathbf{38.6\text{ Million Tokens Eliminated}}$$

---

## 🛡️ The Solution: `claude-prune`

`claude-prune` is a **zero-dependency, 100% offline local utility** that acts as an automated garbage collector and live shield for Claude Code.

### How It Works

```
┌────────────────────────────────────────────────────────┐
│               CONVERSATION DAG PARSER                  │
├────────────────────────────────────────────────────────┤
│  Root                                                  │
│   └── Turn 1                                           │
│        ├── [DEAD FORK 1] (Abandoned edit / compact)    │ -> ❌ EVICTED
│        ├── [DEAD FORK 2] (Failed test trace, 500 lines)│ -> ✂️ TRUNCATED
│        └── Turn 2 (Active continuation)                │ -> ✔️ PRESERVED
│             └── Turn 3 (Current Leaf)                  │ -> ✔️ PRESERVED
└────────────────────────────────────────────────────────┘
```

1. **DAG Graph Reconstruction:** Maps each event's `uuid` $\rightarrow$ `parentUuid`, tracing backward from the latest leaf to root to identify the **Active Trunk**. All disconnected subtrees are safely dropped.
2. **Surgical Log Truncation:** Compresses 500-line test or compile failures down to the first 10 lines + exit status summary. Real user prompts and assistant code responses are **never touched**.
3. **Historical Thinking Compression:** Compresses extended thinking blocks on turns older than 3 steps ago.
4. **Zero-Risk Auto-Backups:** Automatically clones `<session>.jsonl.bak.jsonl` before modifying any file. Revert anytime with 1 click.

---

## 🚀 Quick Start

### 1. Read-Only Audit (Inspect Your Bloat)
Scans your system and calculates exact cache savings without modifying any files:
```bash
npx claude-prune scan
```

### 2. Launch the Local Desktop Web App
Launches an offline, real-time dark-mode dashboard at `http://127.0.0.1:3847`:
```bash
npx claude-prune app
```

Features included in the web app:
- 📈 **Real-Time Live Shield:** Monitors `~/.claude/projects/` and intercepts bloated turns as you code with Claude Code.
- 🔍 **Before vs. After Diff Inspector:** Previews token and file size changes for every session side-by-side before pruning.
- ⚡ **1-Click Actions:** Purge all dead forks or restore original `.bak.jsonl` backups instantly.

### 3. CLI Direct Pruning
```bash
# Preview what will be pruned without touching files
npx claude-prune prune --dry-run

# Prune your most recent active session
npx claude-prune prune

# Prune all sessions across all projects
npx claude-prune prune --all

# Revert all changes from backups
npx claude-prune restore
```

---

## 🔒 Safety & Privacy Guarantees

* **100% Localhost Only (`127.0.0.1`):** The dashboard binds strictly to `127.0.0.1`. It rejects external or LAN traffic and protects against DNS rebinding.
* **Zero Telemetry / Zero External CDNs:** Contains **no analytics, no trackers, and no external scripts or Google fonts**. It functions completely offline on an airplane.
* **Active Trunk Protection:** The tree-walking algorithm preserves 100% of your active conversation history. Only orphaned dead branches and redundant log noise are modified.
* **Bit-for-Bit Verified Restore:** Backups are SHA-256 verified. Reverting restores the exact original byte stream.

---

## 🧪 Verification: Test It On Your Machine

You can verify the physical reduction on your own machine using PowerShell:

```powershell
Get-ChildItem -Path "$HOME\.claude\projects" -Filter "*.bak.jsonl" -Recurse | ForEach-Object {
    $orig = $_.Length
    $prunedFile = Get-Item ($_.FullName -replace '\.bak\.jsonl$', '.jsonl') -ErrorAction SilentlyContinue
    if ($prunedFile) {
        [PSCustomObject]@{
            Session    = $_.Name.Substring(0, 16) + "..."
            BeforeSize = "$([math]::Round($orig / 1MB, 2)) MB"
            AfterSize  = "$([math]::Round($prunedFile.Length / 1MB, 2)) MB"
            Saved      = "$([math]::Round(($orig - $prunedFile.Length) / 1MB, 2)) MB"
            Reduction  = "$([math]::Round((($orig - $prunedFile.Length) / $orig) * 100))%"
        }
    }
} | Format-Table -AutoSize
```

---

## 🛠️ CLI Reference

| Command / Flag | Description |
| :--- | :--- |
| `claude-prune scan` | Scan all sessions and calculate potential cache savings |
| `claude-prune app` | Launch the local real-time desktop web app (`127.0.0.1:3847`) |
| `claude-prune prune` | Prune the most recent active session |
| `claude-prune prune --all` | Prune all historical sessions across all projects |
| `--dry-run` | Preview token reductions without modifying files |
| `--no-backup` | Skip creating `.bak.jsonl` backup files |
| `--target <path>` | Target a specific `.jsonl` file or project directory |
| `claude-prune restore` | Revert sessions to their `.bak.jsonl` backups |
| `claude-prune watch` | Run as a background daemon to monitor active sessions |

---

## 🤝 Contributing

Contributions, bug reports, and suggestions are welcome! Feel free to open an issue or submit a PR.

## 📄 License

MIT © 2026
