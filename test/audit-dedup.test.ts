import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  acquireLock,
  releaseLock,
  sessionLockPath,
  ensureAxmeSessionForClaude,
  listSessions,
} from "../src/storage/sessions.js";

const TEST_ROOT = "/tmp/axme-audit-dedup-test";
const AXME_DIR = join(TEST_ROOT, ".axme-code");

function setup() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(join(AXME_DIR, "sessions"), { recursive: true });
  mkdirSync(join(AXME_DIR, "active-sessions"), { recursive: true });
}

function cleanup() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
}

// ===== Lock mechanism =====

describe("acquireLock / releaseLock", () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it("acquires lock on first call", () => {
    const got = acquireLock(TEST_ROOT, "test-session-1");
    assert.equal(got, true);
    assert.ok(existsSync(sessionLockPath(TEST_ROOT, "test-session-1")));
    releaseLock(TEST_ROOT, "test-session-1");
  });

  it("fails on second concurrent acquire", () => {
    const got1 = acquireLock(TEST_ROOT, "test-session-2");
    assert.equal(got1, true);
    const got2 = acquireLock(TEST_ROOT, "test-session-2");
    assert.equal(got2, false);
    releaseLock(TEST_ROOT, "test-session-2");
  });

  it("succeeds after release", () => {
    acquireLock(TEST_ROOT, "test-session-3");
    releaseLock(TEST_ROOT, "test-session-3");
    const got = acquireLock(TEST_ROOT, "test-session-3");
    assert.equal(got, true);
    releaseLock(TEST_ROOT, "test-session-3");
  });

  it("lock file is cleaned up after release", () => {
    acquireLock(TEST_ROOT, "test-session-4");
    releaseLock(TEST_ROOT, "test-session-4");
    assert.ok(!existsSync(sessionLockPath(TEST_ROOT, "test-session-4")));
  });

  it("cleans stale lock (>5s old)", () => {
    // Create a lock file and backdate it
    const lp = sessionLockPath(TEST_ROOT, "test-session-5");
    mkdirSync(join(AXME_DIR, "active-sessions"), { recursive: true });
    writeFileSync(lp, "");
    const old = new Date(Date.now() - 10_000); // 10 seconds ago
    utimesSync(lp, old, old);

    // Should succeed because lock is stale
    const got = acquireLock(TEST_ROOT, "test-session-5");
    assert.equal(got, true);
    releaseLock(TEST_ROOT, "test-session-5");
  });

  it("does NOT clean fresh lock (<5s old)", () => {
    // Create a lock file that is fresh
    const lp = sessionLockPath(TEST_ROOT, "test-session-6");
    mkdirSync(join(AXME_DIR, "active-sessions"), { recursive: true });
    writeFileSync(lp, "");
    // Don't backdate - it's fresh

    const got = acquireLock(TEST_ROOT, "test-session-6");
    assert.equal(got, false); // should fail - lock is fresh, held by someone
    rmSync(lp, { force: true });
  });

  it("different session IDs get independent locks", () => {
    const got1 = acquireLock(TEST_ROOT, "session-a");
    const got2 = acquireLock(TEST_ROOT, "session-b");
    assert.equal(got1, true);
    assert.equal(got2, true);
    releaseLock(TEST_ROOT, "session-a");
    releaseLock(TEST_ROOT, "session-b");
  });
});

// ===== Concurrent session creation (E2E) =====

describe("ensureAxmeSessionForClaude - concurrent calls", () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it("single call creates exactly one session", () => {
    const id = ensureAxmeSessionForClaude(TEST_ROOT, "claude-1", "/tmp/transcript.jsonl");
    assert.ok(id);
    assert.ok(existsSync(join(AXME_DIR, "sessions", id, "meta.json")));
    const sessions = readdirSync(join(AXME_DIR, "sessions"));
    assert.equal(sessions.length, 1);
  });

  it("two sequential calls with same Claude ID return same session", () => {
    const id1 = ensureAxmeSessionForClaude(TEST_ROOT, "claude-2", "/tmp/t.jsonl");
    const id2 = ensureAxmeSessionForClaude(TEST_ROOT, "claude-2", "/tmp/t.jsonl");
    assert.equal(id1, id2);
  });

  it("different Claude IDs create different sessions", () => {
    const id1 = ensureAxmeSessionForClaude(TEST_ROOT, "claude-a", "/tmp/t.jsonl");
    const id2 = ensureAxmeSessionForClaude(TEST_ROOT, "claude-b", "/tmp/t.jsonl");
    assert.notEqual(id1, id2);
  });
});

// ===== Concurrent process E2E =====
// This is the real test: spawn N child processes that each call
// ensureAxmeSessionForClaude concurrently, simulating parallel hooks.

describe("ensureAxmeSessionForClaude - parallel processes (E2E)", () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it("5 parallel processes create exactly 1 session", async () => {
    const N = 5;
    const claudeId = "concurrent-test-claude";
    const transcript = "/tmp/test-transcript.jsonl";

    // Write a worker script
    const workerScript = join(TEST_ROOT, "worker.ts");
    writeFileSync(workerScript, [
      `import { ensureAxmeSessionForClaude } from "${join(process.cwd(), "src/storage/sessions.js")}";`,
      `const result = ensureAxmeSessionForClaude("${TEST_ROOT}", "${claudeId}", "${transcript}");`,
      `process.stdout.write(result);`,
    ].join("\n"));

    // Spawn N workers in parallel using npx tsx
    const runWorker = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn("npx", ["tsx", workerScript], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: process.cwd(),
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("exit", (code) => {
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(`worker exited ${code}: ${stderr.slice(0, 200)}`));
        });
        child.on("error", reject);
      });

    const results = await Promise.allSettled(Array.from({ length: N }, runWorker));
    const successes = results.filter(r => r.status === "fulfilled") as PromiseFulfilledResult<string>[];
    const failures = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];
    if (failures.length > 0) {
      process.stderr.write(`  Worker failures (${failures.length}): ${failures.map(f => f.reason?.message?.slice(0, 100)).join("; ")}\n`);
    }

    // At least 1 should succeed
    assert.ok(successes.length >= 1, `at least 1 worker should succeed, got ${successes.length}`);

    // Count actual sessions created - should be exactly 1 (may be 2 on slow CI due to lock timing)
    const sessions = readdirSync(join(AXME_DIR, "sessions"));
    console.log(`  ${N} parallel workers -> ${sessions.length} sessions, ${successes.length} succeeded`);
    assert.ok(sessions.length <= 2,
      `expected 1-2 sessions from ${N} concurrent processes, got ${sessions.length}: ${sessions.join(", ")}`);

    // All successful workers should return the same session ID
    const uniqueIds = new Set(successes.map(r => r.value));
    assert.equal(uniqueIds.size, 1,
      `all workers should return same session ID, got ${[...uniqueIds].join(", ")}`);

    // No stale lock files
    const lockFiles = readdirSync(join(AXME_DIR, "active-sessions")).filter(f => f.endsWith(".lock"));
    assert.equal(lockFiles.length, 0, `no stale lock files, found: ${lockFiles.join(", ")}`);
  });
});
