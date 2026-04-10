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

  it("payload contains no raw error message or stack", async () => {
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

    reportError("hook", "network_error", false);
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(received);
    const event = received.events[0];
    // Required fields only
    assert.deepStrictEqual(
      Object.keys(event).sort(),
      ["arch", "category", "ci", "error_class", "event", "fatal", "mid", "os", "source", "ts", "version"].sort(),
    );
    // No stack or message field
    assert.equal(event.message, undefined);
    assert.equal(event.stack, undefined);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

// --- Lifecycle: install/startup/update with strict counts ---

describe("lifecycle events strict counts", () => {
  it("first run fires exactly 1 install + 1 startup, no update", async () => {
    const events: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const p = JSON.parse(body);
          if (Array.isArray(p.events)) events.push(...p.events);
        } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/telemetry/events`;

    await sendStartupEvents();

    const installs = events.filter(e => e.event === "install");
    const startups = events.filter(e => e.event === "startup");
    const updates = events.filter(e => e.event === "update");
    assert.equal(installs.length, 1, "exactly 1 install on first run");
    assert.equal(startups.length, 1, "exactly 1 startup on first run");
    assert.equal(updates.length, 0, "no update on first run");

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("second run fires only 1 startup, no install", async () => {
    const events: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const p = JSON.parse(body);
          if (Array.isArray(p.events)) events.push(...p.events);
        } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/telemetry/events`;

    // First run: create the mid file via getOrCreateMid
    getOrCreateMid();
    // Need to also write last-version to simulate previous run
    writeLastVersion("0.0.0-dev"); // matches AXME_CODE_VERSION in test
    _resetForTests();

    await sendStartupEvents();

    const installs = events.filter(e => e.event === "install");
    const startups = events.filter(e => e.event === "startup");
    const updates = events.filter(e => e.event === "update");
    assert.equal(installs.length, 0, "no install on second run");
    assert.equal(startups.length, 1, "exactly 1 startup on second run");
    assert.equal(updates.length, 0, "no update if version unchanged");

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("update fires exactly 1 update with previous_version field when version changed", async () => {
    const events: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const p = JSON.parse(body);
          if (Array.isArray(p.events)) events.push(...p.events);
        } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/telemetry/events`;

    // Simulate prior install with old version
    getOrCreateMid();
    writeLastVersion("0.2.5");
    _resetForTests();

    await sendStartupEvents();

    const updates = events.filter(e => e.event === "update");
    assert.equal(updates.length, 1, "exactly 1 update when version changed");
    assert.equal(updates[0].previous_version, "0.2.5", "update has previous_version");

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("repeated sendStartupEvents calls in same process are no-op (processStartupSent guard)", async () => {
    const events: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const p = JSON.parse(body);
          if (Array.isArray(p.events)) events.push(...p.events);
        } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/telemetry/events`;

    await sendStartupEvents();
    await sendStartupEvents();
    await sendStartupEvents();

    const startups = events.filter(e => e.event === "startup");
    assert.equal(startups.length, 1, "exactly 1 startup despite 3 calls");

    await new Promise<void>((r) => server.close(() => r()));
  });
});

// --- ci field in payloads ---

describe("ci field detection in events", () => {
  it("ci=true ends up in sent event when CI env is set", async () => {
    process.env.CI = "true";
    let received: any = null;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { received = JSON.parse(body); } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/telemetry/events`;

    sendTelemetry("startup");
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(received, "request received");
    assert.equal(received.events[0].ci, true, "ci=true in payload");

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("ci=false in payload by default (no CI env)", async () => {
    let received: any = null;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { received = JSON.parse(body); } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/telemetry/events`;

    sendTelemetry("startup");
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(received, "request received");
    assert.equal(received.events[0].ci, false, "ci=false default");

    await new Promise<void>((r) => server.close(() => r()));
  });
});

// --- Phase 2 payload shapes ---

describe("audit_complete payload shape", () => {
  it("has all 10 spec fields when sent", async () => {
    let received: any = null;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { received = JSON.parse(body); } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/telemetry/events`;

    sendTelemetry("audit_complete", {
      outcome: "success",
      duration_ms: 100000,
      prompt_tokens: 50000,
      cost_usd: 0.42,
      chunks: 1,
      memories_saved: 2,
      decisions_saved: 1,
      safety_saved: 0,
      dropped_count: 0,
      error_class: null,
    });
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(received);
    const event = received.events[0];
    // All 10 audit_complete fields per spec
    for (const field of [
      "outcome", "duration_ms", "prompt_tokens", "cost_usd", "chunks",
      "memories_saved", "decisions_saved", "safety_saved", "dropped_count", "error_class",
    ]) {
      assert.ok(field in event, `audit_complete must contain ${field}`);
    }
    // Common fields
    for (const field of ["event", "version", "source", "os", "arch", "ci", "mid", "ts"]) {
      assert.ok(field in event, `audit_complete must contain common ${field}`);
    }

    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("setup_complete payload shape", () => {
  it("has all 9 spec fields when sent", async () => {
    let received: any = null;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { received = JSON.parse(body); } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    process.env.AXME_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/v1/telemetry/events`;

    sendTelemetry("setup_complete", {
      outcome: "success",
      duration_ms: 30000,
      method: "llm",
      scanners_run: 4,
      scanners_failed: 0,
      phase_failed: null,
      presets_applied: 2,
      is_workspace: false,
      child_repos: 0,
    });
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(received);
    const event = received.events[0];
    // All 9 setup_complete fields per spec
    for (const field of [
      "outcome", "duration_ms", "method", "scanners_run", "scanners_failed",
      "phase_failed", "presets_applied", "is_workspace", "child_repos",
    ]) {
      assert.ok(field in event, `setup_complete must contain ${field}`);
    }

    await new Promise<void>((r) => server.close(() => r()));
  });
});

// --- Queue cap ---

describe("offline queue cap", () => {
  it("caps queue at 100 events, drops oldest when over cap", async () => {
    process.env.AXME_TELEMETRY_ENDPOINT = "http://127.0.0.1:1/dead";
    // Send 105 events, none will succeed (network closed)
    for (let i = 0; i < 105; i++) {
      sendTelemetry("startup", { test_seq: i });
    }
    await new Promise((r) => setTimeout(r, 1000));

    const queuePath = _getQueueFilePath();
    assert.equal(existsSync(queuePath), true, "queue file exists");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    assert.ok(lines.length <= 100, `queue must be capped at 100, got ${lines.length}`);
    // Oldest events dropped: first event in file should NOT be test_seq 0
    if (lines.length === 100) {
      const first = JSON.parse(lines[0]);
      assert.ok(first.test_seq >= 5, `oldest 5 events dropped, first should have test_seq >= 5, got ${first.test_seq}`);
    }
  });
});

// --- classifyError extra coverage ---

describe("classifyError extra slugs", () => {
  it("classifies api_error", () => {
    assert.equal(classifyError(new Error("API error: 500 internal")), "api_error");
    assert.equal(classifyError(new Error("HTTP 503 Service Unavailable")), "api_error");
  });

  it("classifies disk_full", () => {
    assert.equal(classifyError(new Error("ENOSPC: no space left on device")), "disk_full");
  });

  it("classifies permission_denied", () => {
    assert.equal(classifyError(new Error("EACCES: permission denied")), "permission_denied");
  });
});
