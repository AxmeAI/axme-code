import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import {
  logEvent,
  readWorklog,
  showWorklog,
  logSessionStart,
  logSessionEnd,
  logSafetyBlock,
  logAuditComplete,
  logError,
  worklogStats,
} from "../src/storage/worklog.js";

const ROOT = "/tmp/axme-worklog-test";
const AXME_DIR = `${ROOT}/.axme-code`;

describe("worklog store", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(AXME_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("logEvent + readWorklog round-trip (type, sessionId, data present)", () => {
    logEvent(ROOT, "session_start", "sess-001", { foo: "bar" });
    const events = readWorklog(ROOT);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "session_start");
    assert.equal(events[0].sessionId, "sess-001");
    assert.equal(events[0].data.foo, "bar");
    assert.ok(events[0].timestamp);
  });

  it("readWorklog newest first", () => {
    logEvent(ROOT, "session_start", "sess-a");
    logEvent(ROOT, "session_end", "sess-b");
    logEvent(ROOT, "error", "sess-c");
    const events = readWorklog(ROOT);
    assert.equal(events.length, 3);
    // Last logged event should be first in results (newest first)
    assert.equal(events[0].type, "error");
    assert.equal(events[2].type, "session_start");
  });

  it("readWorklog with limit=2", () => {
    logEvent(ROOT, "session_start", "s1");
    logEvent(ROOT, "session_end", "s2");
    logEvent(ROOT, "error", "s3");
    const events = readWorklog(ROOT, { limit: 2 });
    assert.equal(events.length, 2);
  });

  it("readWorklog filtered by type", () => {
    logEvent(ROOT, "session_start", "s1");
    logEvent(ROOT, "error", "s2");
    logEvent(ROOT, "session_start", "s3");
    const events = readWorklog(ROOT, { type: "session_start" });
    assert.equal(events.length, 2);
    assert.ok(events.every(e => e.type === "session_start"));
  });

  it("showWorklog formats timestamp and data", () => {
    logEvent(ROOT, "session_start", "s1", { user: "george" });
    const output = showWorklog(ROOT);
    assert.ok(output.includes("session_start"));
    assert.ok(output.includes("user=george"));
    // Timestamp should be formatted (no T, just space)
    assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(output));
  });

  it("logSessionStart creates session_start event", () => {
    logSessionStart(ROOT, "start-sess");
    const events = readWorklog(ROOT, { type: "session_start" });
    assert.equal(events.length, 1);
    assert.equal(events[0].sessionId, "start-sess");
  });

  it("logSessionEnd with metadata (filesCount, auditRan)", () => {
    logSessionEnd(ROOT, "end-sess", { filesCount: 5, auditRan: true });
    const events = readWorklog(ROOT, { type: "session_end" });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.filesCount, 5);
    assert.equal(events[0].data.auditRan, true);
  });

  it("logSafetyBlock records tool/target/reason", () => {
    logSafetyBlock(ROOT, "sb-sess", "bash", "rm -rf /", "denied-prefix", "destructive command");
    const events = readWorklog(ROOT, { type: "safety_block" });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.tool, "bash");
    assert.equal(events[0].data.target, "rm -rf /");
    assert.equal(events[0].data.reason, "destructive command");
    assert.equal(events[0].data.rule, "denied-prefix");
  });

  it("logAuditComplete records costUsd/memories/decisions/safety/durationMs", () => {
    logAuditComplete(ROOT, "audit-sess", {
      costUsd: 0.42,
      memories: 3,
      decisions: 2,
      safety: 1,
      durationMs: 5000,
    });
    const events = readWorklog(ROOT, { type: "audit_complete" });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.costUsd, 0.42);
    assert.equal(events[0].data.memories, 3);
    assert.equal(events[0].data.decisions, 2);
    assert.equal(events[0].data.safety, 1);
    assert.equal(events[0].data.durationMs, 5000);
  });

  it("logError records error message", () => {
    logError(ROOT, "err-sess", "Something went wrong");
    const events = readWorklog(ROOT, { type: "error" });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.error, "Something went wrong");
  });

  it("worklogStats counts sessions and audits", () => {
    logSessionStart(ROOT, "s1");
    logSessionStart(ROOT, "s2");
    logAuditComplete(ROOT, "s1", { costUsd: 0.1, memories: 0, decisions: 0, safety: 0, durationMs: 100 });
    const stats = worklogStats(ROOT);
    assert.equal(stats.totalSessions, 2);
    assert.equal(stats.totalAudits, 1);
  });

  it("worklogStats sums costUsd", () => {
    logAuditComplete(ROOT, "s1", { costUsd: 0.25, memories: 0, decisions: 0, safety: 0, durationMs: 100 });
    logAuditComplete(ROOT, "s2", { costUsd: 0.75, memories: 0, decisions: 0, safety: 0, durationMs: 200 });
    const stats = worklogStats(ROOT);
    assert.equal(stats.totalCostUsd, 1.0);
  });

  it("worklogStats collects safety blocks", () => {
    logSafetyBlock(ROOT, "s1", "bash", "rm -rf /", "denied", "dangerous");
    logSafetyBlock(ROOT, "s1", "git", "force push", "denied", "protected branch");
    const stats = worklogStats(ROOT);
    assert.equal(stats.safetyBlocks.length, 2);
    assert.equal(stats.safetyBlocks[0].tool, "git"); // newest first
    assert.equal(stats.safetyBlocks[1].tool, "bash");
  });

  it("worklogStats collects recent errors (max 10)", () => {
    for (let i = 0; i < 15; i++) {
      logError(ROOT, "s1", `Error ${i}`);
    }
    const stats = worklogStats(ROOT);
    assert.equal(stats.recentErrors.length, 10);
  });

  it("empty worklog: readWorklog returns [], showWorklog returns 'No worklog events.'", () => {
    const events = readWorklog(ROOT);
    assert.deepEqual(events, []);
    const output = showWorklog(ROOT);
    assert.equal(output, "No worklog events.");
  });
});
