/**
 * Tests for src/telemetry.ts.
 *
 * Strategy: point AXME_TELEMETRY_STATE_DIR at a per-test temp directory and
 * AXME_TELEMETRY_ENDPOINT at a local HTTP server stub. Each test exercises one
 * concrete behavior (mid generation, opt-out, queue, classifyError, etc.).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

import {
  classifyError,
  detectSource,
  isCI,
  isTelemetryDisabled,
  getOrCreateMid,
  readLastVersion,
  writeLastVersion,
  sendTelemetry,
  sendStartupEvents,
  reportError,
  _resetForTests,
  _getMidFilePath,
  _getQueueFilePath,
  _getLastVersionFilePath,
} from "../src/telemetry.ts";

// --- Test fixtures ---

let testDir: string;
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "axme-telemetry-test-"));
  // Snapshot env vars we mutate
  originalEnv = {
    AXME_TELEMETRY_STATE_DIR: process.env.AXME_TELEMETRY_STATE_DIR,
    AXME_TELEMETRY_DISABLED: process.env.AXME_TELEMETRY_DISABLED,
    AXME_TELEMETRY_ENDPOINT: process.env.AXME_TELEMETRY_ENDPOINT,
    DO_NOT_TRACK: process.env.DO_NOT_TRACK,
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
    CI: process.env.CI,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
  };
  process.env.AXME_TELEMETRY_STATE_DIR = testDir;
  delete process.env.AXME_TELEMETRY_DISABLED;
  delete process.env.AXME_TELEMETRY_ENDPOINT;
  delete process.env.DO_NOT_TRACK;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  _resetForTests();
});

afterEach(() => {
  // Restore env
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(testDir, { recursive: true, force: true });
  _resetForTests();
});

// --- Mid generation ---

describe("getOrCreateMid", () => {
  it("generates a 64-hex mid on first call", () => {
    const { mid, isNew } = getOrCreateMid();
    assert.equal(isNew, true);
    assert.match(mid, /^[0-9a-f]{64}$/);
  });

  it("persists mid to disk", () => {
    const { mid } = getOrCreateMid();
    const filePath = _getMidFilePath();
    assert.equal(existsSync(filePath), true);
    assert.equal(readFileSync(filePath, "utf-8").trim(), mid);
  });

  it("sets file mode 0600", () => {
    getOrCreateMid();
    const mode = statSync(_getMidFilePath()).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("returns same mid on second call (cached)", () => {
    const { mid: mid1 } = getOrCreateMid();
    const { mid: mid2, isNew } = getOrCreateMid();
    assert.equal(mid1, mid2);
    assert.equal(isNew, false);
  });

  it("returns existing mid from disk after reset", () => {
    const { mid: mid1 } = getOrCreateMid();
    _resetForTests();
    const { mid: mid2, isNew } = getOrCreateMid();
    assert.equal(mid1, mid2);
    assert.equal(isNew, false);
  });

  it("regenerates mid when file is corrupt", () => {
    writeFileSync(_getMidFilePath(), "not-a-valid-hex-string\n");
    _resetForTests();
    const { mid, isNew } = getOrCreateMid();
    assert.match(mid, /^[0-9a-f]{64}$/);
    assert.equal(isNew, true);
  });
});

// --- Opt-out ---

describe("isTelemetryDisabled", () => {
  it("returns false by default", () => {
    assert.equal(isTelemetryDisabled(), false);
  });

  it("returns true when AXME_TELEMETRY_DISABLED is set", () => {
    process.env.AXME_TELEMETRY_DISABLED = "1";
    assert.equal(isTelemetryDisabled(), true);
  });

  it("returns true when DO_NOT_TRACK is set", () => {
    process.env.DO_NOT_TRACK = "1";
    assert.equal(isTelemetryDisabled(), true);
  });
});

// --- Source detection ---

describe("detectSource", () => {
  it("returns 'binary' when CLAUDE_PLUGIN_ROOT is not set", () => {
    assert.equal(detectSource(), "binary");
  });

  it("returns 'plugin' when CLAUDE_PLUGIN_ROOT is set", () => {
    process.env.CLAUDE_PLUGIN_ROOT = "/some/path";
    _resetForTests();
    assert.equal(detectSource(), "plugin");
  });
});

// --- CI detection ---

describe("isCI", () => {
  it("returns false by default", () => {
    assert.equal(isCI(), false);
  });

  it("returns true when CI=1", () => {
    process.env.CI = "1";
    assert.equal(isCI(), true);
  });

  it("returns true when GITHUB_ACTIONS is set", () => {
    process.env.GITHUB_ACTIONS = "true";
    assert.equal(isCI(), true);
  });
});

// --- Last version tracking ---

describe("last version tracking", () => {
  it("returns null when no last-version file exists", () => {
    assert.equal(readLastVersion(), null);
  });

  it("writes and reads back last version", () => {
    writeLastVersion("0.2.5");
    assert.equal(readLastVersion(), "0.2.5");
  });

  it("overwrites existing last version", () => {
    writeLastVersion("0.2.5");
    writeLastVersion("0.2.6");
    assert.equal(readLastVersion(), "0.2.6");
  });
});

// --- classifyError ---

describe("classifyError", () => {
  it("classifies prompt-too-long errors", () => {
    assert.equal(classifyError(new Error("Prompt is too long for context window")), "prompt_too_long");
    assert.equal(classifyError(new Error("max tokens exceeded")), "prompt_too_long");
    assert.equal(classifyError(new Error("Context length 200000 exceeded")), "prompt_too_long");
  });

  it("classifies rate limit errors", () => {
    assert.equal(classifyError(new Error("Rate limit reached")), "api_rate_limit");
    assert.equal(classifyError(new Error("HTTP 429 Too Many Requests")), "api_rate_limit");
  });

  it("classifies auth errors", () => {
    assert.equal(classifyError(new Error("Authentication failed")), "oauth_missing");
    assert.equal(classifyError(new Error("Missing API key")), "oauth_missing");
  });

  it("classifies timeout errors", () => {
    assert.equal(classifyError(new Error("Operation timed out")), "timeout");
    assert.equal(classifyError(new Error("Request aborted")), "timeout");
  });

  it("classifies network errors", () => {
    assert.equal(classifyError(new Error("ECONNREFUSED")), "network_error");
    assert.equal(classifyError(new Error("fetch failed")), "network_error");
  });

  it("classifies file not found errors", () => {
    assert.equal(classifyError(new Error("ENOENT: transcript not found")), "transcript_not_found");
  });

  it("classifies parse errors", () => {
    assert.equal(classifyError(new Error("Unexpected token in JSON")), "parse_error");
    assert.equal(classifyError(new Error("Invalid JSON output")), "parse_error");
  });

  it("returns 'unknown' for unrecognized errors", () => {
    assert.equal(classifyError(new Error("something completely random")), "unknown");
    assert.equal(classifyError("string error"), "unknown");
    assert.equal(classifyError(null), "unknown");
  });

  it("never throws on weird inputs", () => {
    assert.equal(classifyError(undefined), "unknown");
    assert.equal(classifyError(42), "unknown");
    assert.equal(classifyError({ foo: "bar" }), "unknown");
  });
});

// --- HTTP send + queue ---

describe("sendTelemetry with HTTP stub", () => {
  let server: Server;
  let receivedRequests: Array<{ events: any[] }>;

  beforeEach(async () => {
    receivedRequests = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try { receivedRequests.push(JSON.parse(body)); } catch { /* ignore */ }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (addr && typeof addr === "object") {
      process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/v1/telemetry/events`;
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends startup event with required common fields", async () => {
    sendTelemetry("startup");
    // Wait for setImmediate + fetch
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(receivedRequests.length, 1);
    const event = receivedRequests[0].events[0];
    assert.equal(event.event, "startup");
    assert.match(event.mid, /^[0-9a-f]{64}$/);
    assert.ok(event.version);
    assert.ok(event.os);
    assert.ok(event.arch);
    assert.equal(typeof event.ci, "boolean");
    assert.ok(event.ts);
    assert.ok(["binary", "plugin"].includes(event.source));
  });

  it("sends audit_complete event with payload fields", async () => {
    sendTelemetry("audit_complete", {
      outcome: "success",
      duration_ms: 12345,
      memories_saved: 2,
      decisions_saved: 1,
      safety_saved: 0,
      dropped_count: 0,
      cost_usd: 1.23,
      prompt_tokens: 50000,
      chunks: 1,
      error_class: null,
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(receivedRequests.length, 1);
    const event = receivedRequests[0].events[0];
    assert.equal(event.event, "audit_complete");
    assert.equal(event.outcome, "success");
    assert.equal(event.memories_saved, 2);
    assert.equal(event.cost_usd, 1.23);
  });

  it("does NOT send when AXME_TELEMETRY_DISABLED is set", async () => {
    process.env.AXME_TELEMETRY_DISABLED = "1";
    sendTelemetry("startup");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(receivedRequests.length, 0);
  });

  it("does NOT send when DO_NOT_TRACK is set", async () => {
    process.env.DO_NOT_TRACK = "1";
    sendTelemetry("startup");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(receivedRequests.length, 0);
  });

  it("does NOT generate mid file when disabled", async () => {
    process.env.AXME_TELEMETRY_DISABLED = "1";
    sendTelemetry("startup");
    sendStartupEvents();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(existsSync(_getMidFilePath()), false);
  });

  it("queues event to disk when network fails", async () => {
    // Stop the server so request fails
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.AXME_TELEMETRY_ENDPOINT = "http://127.0.0.1:1/dead-endpoint";

    sendTelemetry("startup");
    await new Promise((r) => setTimeout(r, 500));

    const queuePath = _getQueueFilePath();
    assert.equal(existsSync(queuePath), true);
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const queued = JSON.parse(lines[0]);
    assert.equal(queued.event, "startup");
  });

  it("flushes queue on next successful send", async () => {
    // First, fail and queue
    const port = (server.address() as any).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.AXME_TELEMETRY_ENDPOINT = "http://127.0.0.1:1/dead";
    sendTelemetry("startup", { test: "first" });
    await new Promise((r) => setTimeout(r, 500));

    // Verify queue has 1 event
    assert.equal(existsSync(_getQueueFilePath()), true);

    // Restart server on a new port and point endpoint at it
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try { receivedRequests.push(JSON.parse(body)); } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const newPort = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${newPort}/v1/telemetry/events`;

    // Send again — should ship queued + new in one batch
    receivedRequests.length = 0;
    sendTelemetry("startup", { test: "second" });
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].events.length, 2);
    // Queue should be cleared
    assert.equal(existsSync(_getQueueFilePath()), false);
  });
});

// --- sendStartupEvents lifecycle ---

describe("sendStartupEvents", () => {
  it("is idempotent within a single process", async () => {
    let callCount = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try { JSON.parse(body); callCount++; } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/telemetry/events`;

    sendStartupEvents();
    sendStartupEvents();
    sendStartupEvents();
    await new Promise((r) => setTimeout(r, 300));

    // First call sends install + startup (2 batches with batch limit), second/third calls do nothing
    // We can't strictly count because batching is async, but it must be more than 0 and not 9
    assert.ok(callCount >= 1);
    assert.ok(callCount <= 4);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

// --- reportError ---

describe("reportError", () => {
  it("sends an error event with category, error_class, fatal", async () => {
    let received: any = null;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try { received = JSON.parse(body); } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/telemetry/events`;

    reportError("audit", "prompt_too_long", true);
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(received);
    const event = received.events[0];
    assert.equal(event.event, "error");
    assert.equal(event.category, "audit");
    assert.equal(event.error_class, "prompt_too_long");
    assert.equal(event.fatal, true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
