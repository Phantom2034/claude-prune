import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { analyzeConversationGraph, parseSessionFile } from "../tree.js";
import { pruneSessionFile, restoreBackup } from "../pruner.js";
function sha256(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
}
test("1. analyzeConversationGraph identifies complex multi-branch forks and /compact roots", () => {
    const events = [
        { uuid: "root", parentUuid: null, type: "user", message: { content: "Start" } },
        { uuid: "t1", parentUuid: "root", type: "assistant", message: { content: "Turn 1" } },
        // Dead branch 1: user edited prompt at turn 1
        { uuid: "dead-fork-1", parentUuid: "t1", type: "user", message: { content: "Wrong direction" } },
        { uuid: "dead-fork-2", parentUuid: "dead-fork-1", type: "assistant", message: { content: "Wrong answer" } },
        // Active path continues
        { uuid: "t2", parentUuid: "t1", type: "user", message: { content: "Right direction" } },
        { uuid: "t3", parentUuid: "t2", type: "assistant", message: { content: "Turn 3" } },
        // Dead branch 2: abandoned sub-tree
        { uuid: "dead-fork-3", parentUuid: "t3", type: "user", message: { content: "Another dead branch" } },
        // Final active leaf
        { uuid: "t4", parentUuid: "t3", type: "user", message: { content: "Finish task" } },
    ];
    const uuidMap = new Map();
    for (const e of events) {
        if (e.uuid)
            uuidMap.set(e.uuid, e);
    }
    const { activeUuids, deadBranchUuids, latestLeafUuid } = analyzeConversationGraph(events, uuidMap);
    assert.equal(latestLeafUuid, "t4");
    assert.equal(activeUuids.size, 5); // root, t1, t2, t3, t4
    assert.equal(deadBranchUuids.size, 3); // dead-fork-1, dead-fork-2, dead-fork-3
    assert.ok(activeUuids.has("root"));
    assert.ok(activeUuids.has("t1"));
    assert.ok(activeUuids.has("t2"));
    assert.ok(activeUuids.has("t3"));
    assert.ok(activeUuids.has("t4"));
    assert.ok(deadBranchUuids.has("dead-fork-1"));
    assert.ok(deadBranchUuids.has("dead-fork-2"));
    assert.ok(deadBranchUuids.has("dead-fork-3"));
});
test("2. Resilience: Gracefully handles corrupted, empty, or partial lines without crashing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-prune-corrupt-"));
    const corruptFile = path.join(tmpDir, "corrupted.jsonl");
    // Mix valid events with broken lines and empty spaces
    const corruptedContent = [
        JSON.stringify({ uuid: "v1", parentUuid: null, type: "user", message: { content: "Hello" } }),
        "{ broken json line that was cut off mid-write",
        "",
        "   ",
        JSON.stringify({ uuid: "v2", parentUuid: "v1", type: "assistant", message: { content: "Hi!" } }),
        "undefined",
        "null",
    ].join("\n");
    fs.writeFileSync(corruptFile, corruptedContent, "utf-8");
    // Should parse without throwing errors
    const parsed = await parseSessionFile(corruptFile);
    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.activeUuids.has("v1"), true);
    assert.equal(parsed.activeUuids.has("v2"), true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
test("3. Safety Guarantee: Restore restores exact bit-for-bit identical file hash", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-prune-safety-"));
    const testFile = path.join(tmpDir, "session.jsonl");
    const events = [
        { uuid: "1", parentUuid: null, type: "user", message: { content: "Original request" } },
        { uuid: "2", parentUuid: "1", type: "assistant", message: { content: "Original response" } },
        { uuid: "dead", parentUuid: "2", type: "user", message: { content: "Dead branch" } },
        { uuid: "3", parentUuid: "2", type: "user", message: { content: "Active continuation" } },
    ];
    fs.writeFileSync(testFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    const originalHash = sha256(testFile);
    // Run pruning with backup enabled
    await pruneSessionFile(testFile, { createBackup: true, pruneDeadBranches: true });
    const prunedHash = sha256(testFile);
    assert.notEqual(originalHash, prunedHash, "Pruned file must be different from original");
    // Restore from backup
    const didRestore = restoreBackup(testFile);
    assert.equal(didRestore, true);
    const restoredHash = sha256(testFile);
    assert.equal(originalHash, restoredHash, "Restored file hash must match original file hash exactly");
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
test("4. Idempotency: Pruning an already pruned session is safe and causes no further degradation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-prune-idempotent-"));
    const testFile = path.join(tmpDir, "session.jsonl");
    const events = [
        { uuid: "1", parentUuid: null, type: "user", message: { content: "Task" } },
        {
            uuid: "2",
            parentUuid: "1",
            type: "assistant",
            tool_result: "Log line\n".repeat(100),
        },
        { uuid: "3", parentUuid: "2", type: "user", message: { content: "Next" } },
    ];
    fs.writeFileSync(testFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    // First prune pass
    const pass1 = await pruneSessionFile(testFile, { maxToolOutputChars: 300, createBackup: false });
    assert.ok(pass1.tokensSaved > 0);
    const hashAfterPass1 = sha256(testFile);
    // Second prune pass on the same file
    const pass2 = await pruneSessionFile(testFile, { maxToolOutputChars: 300, createBackup: false });
    const hashAfterPass2 = sha256(testFile);
    assert.equal(pass2.deadEventsRemoved, 0, "No additional dead events should be removed on second pass");
    assert.equal(hashAfterPass1, hashAfterPass2, "File content should remain identical on second prune pass");
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
test("5. Scale Benchmark: Efficiently processes 50+ turn multi-megabyte sessions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-prune-scale-"));
    const testFile = path.join(tmpDir, "large-session.jsonl");
    const events = [];
    let prevUuid = null;
    // Generate 50 realistic turns with repeated large outputs
    for (let i = 0; i < 50; i++) {
        const userUuid = `u-${i}`;
        events.push({
            uuid: userUuid,
            parentUuid: prevUuid,
            type: "user",
            message: { content: `Prompt turn #${i}: optimize performance` },
        });
        const assistantUuid = `a-${i}`;
        events.push({
            uuid: assistantUuid,
            parentUuid: userUuid,
            type: "assistant",
            thinking: i < 47 ? "Historical thinking trace ".repeat(30) : "Active thinking trace",
            tool_result: i % 2 === 0 ? "Compilation warning and stack details\n".repeat(60) : undefined,
            message: { content: `Assistant turn #${i} finished.` },
        });
        prevUuid = assistantUuid;
    }
    fs.writeFileSync(testFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    const startTime = Date.now();
    const result = await pruneSessionFile(testFile, {
        maxToolOutputChars: 400,
        collapseOldThinking: true,
        createBackup: true,
    });
    const durationMs = Date.now() - startTime;
    assert.ok(result.tokensSaved > 5000, "Should save significant tokens on a 50-turn session");
    assert.ok(result.thinkingBlocksCompressed > 0, "Should compress historical thinking blocks");
    assert.ok(durationMs < 500, `Pruning should execute in under 500ms (took ${durationMs}ms)`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
test("6. Codex CLI Support: Accurately preserves linear timeline and truncates bloated exec_command outputs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prune-test-"));
    const rolloutFile = path.join(tmpDir, "rollout-2026-11-01T12-00-00-abc123.jsonl");
    // OpenAI Codex CLI rollout format: sequential events, no parentUuid, function_call_output with bloated stdout
    const codexEvents = [
        { role: "user", content: "Run the full test suite and fix failures." },
        {
            role: "assistant",
            reasoning_content: "I need to analyze the codebase structure and run pytest. ".repeat(25),
            content: "Running tests with exec_command...",
        },
        {
            type: "function_call",
            name: "exec_command",
            arguments: { cmd: "pytest --verbose tests/" },
        },
        {
            type: "function_call_output",
            name: "exec_command",
            output: "test_core.py::test_eval PASSED\n".repeat(200) + "FAILED tests/test_db.py\nAssertionError: connection timeout",
        },
        {
            role: "assistant",
            content: "I identified the timeout error in test_db.py.",
        },
        { role: "user", content: "Please fix the timeout configuration." },
        { role: "assistant", content: "Updated default database timeout to 30s." },
        { role: "user", content: "Confirmed, tests pass now!" },
    ];
    fs.writeFileSync(rolloutFile, codexEvents.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    // 1. Verify parsing preserves all turns on linear timeline (0 dead branches)
    const tree = await parseSessionFile(rolloutFile);
    assert.equal(tree.events.length, 8);
    assert.equal(tree.deadBranchUuids.size, 0, "Codex linear session must not treat earlier turns as dead branches");
    assert.equal(tree.activeUuids.size, 8, "All linear turns must be active");
    // 2. Prune the Codex session
    const res = await pruneSessionFile(rolloutFile, { maxToolOutputChars: 500, createBackup: true });
    assert.ok(res.tokensSaved > 1000, "Should save significant tokens from bloated pytest log and reasoning");
    assert.equal(res.deadEventsRemoved, 0, "No active conversation turns should be evicted");
    assert.ok(res.toolOutputsTruncated >= 1, "exec_command output should be truncated");
    assert.ok(res.thinkingBlocksCompressed >= 1, "Historical reasoning_content should be compressed");
    // 3. Verify pruned file is valid JSONL and retains schema
    const prunedLines = fs.readFileSync(rolloutFile, "utf-8").trim().split("\n");
    assert.equal(prunedLines.length, 8, "Pruned file must retain all 8 turns");
    const outputEvent = JSON.parse(prunedLines[3]);
    assert.ok(outputEvent.output.includes("claude-prune: truncated"), "Output must contain safe truncation marker");
    // 4. Verify bit-for-bit restore
    assert.equal(restoreBackup(rolloutFile), true);
    const restoredLines = fs.readFileSync(rolloutFile, "utf-8").trim().split("\n");
    assert.equal(JSON.parse(restoredLines[3]).output.length, codexEvents[3].output.length, "Restored file must match original exactly");
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
test("7. Multi-Agent Discovery: Correctly classifies Claude Code and Codex CLI session types", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-discover-"));
    // Create mock Claude session
    const claudeDir = path.join(tmpDir, ".claude", "projects", "C--Users-test-myproject");
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeFile = path.join(claudeDir, "session-12345.jsonl");
    fs.writeFileSync(claudeFile, JSON.stringify({ uuid: "c1", parentUuid: null, type: "user", message: { content: "hi" } }) + "\n");
    // Create mock Codex session
    const codexDir = path.join(tmpDir, ".codex", "sessions", "2026", "11", "02");
    fs.mkdirSync(codexDir, { recursive: true });
    const codexFile = path.join(codexDir, "rollout-2026-11-02-abc.jsonl");
    fs.writeFileSync(codexFile, JSON.stringify({ role: "user", content: "hello codex" }) + "\n");
    // Set environment overrides
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, ".claude");
    process.env.CODEX_HOME = path.join(tmpDir, ".codex");
    try {
        const all = (await import("../locator.js")).discoverSessions();
        const claudeFound = all.find((s) => s.agentType === "claude");
        const codexFound = all.find((s) => s.agentType === "codex");
        assert.ok(claudeFound, "Should discover Claude session");
        assert.equal(claudeFound?.agentType, "claude");
        assert.ok(codexFound, "Should discover Codex session");
        assert.equal(codexFound?.agentType, "codex");
    }
    finally {
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.CODEX_HOME;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
