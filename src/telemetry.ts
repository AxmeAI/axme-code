/**
 * Anonymous telemetry for axme-code.
 *
 * Sends Phase 1 events (install, startup, update) and Phase 2 product-health
 * events (audit_complete, setup_complete, error) to the AXME control plane.
 *
 * - Anonymous: only a random machine id (mid). No PII, no paths, no hostnames.
 * - Best-effort: never blocks user-visible operations, never throws.
 * - Opt-out: AXME_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1 fully disables.
 *
 * See docs/TELEMETRY_TZ.md for the full specification.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { AXME_CODE_VERSION } from "./types.js";

// --- Configuration ---

const DEFAULT_ENDPOINT = "https://api.cloud.axme.ai/v1/telemetry/events";
const QUEUE_MAX_EVENTS = 100;
// Per-request network timeout. Long enough that a heavily-busy event loop
// (parallel LLM scanners) does not falsely flag successful POSTs as failed
// — false-fail caused server-side duplicates because the failed event got
// appended to the offline queue and re-sent on the next call.
const SEND_TIMEOUT_MS = 30_000;

/**
 * Resolved state directory for telemetry files. AXME_TELEMETRY_getStateDir() env
 * var overrides the default (used in tests). Read each call to support
 * test isolation.
 */
function getStateDir(): string {
  return process.env.AXME_TELEMETRY_STATE_DIR || join(homedir(), ".local", "share", "axme-code");
}

function getMidFile(): string { return join(getStateDir(), "machine-id"); }
function getLastVersionFile(): string { return join(getStateDir(), "last-version"); }
function getQueueFile(): string { return join(getStateDir(), "telemetry-queue.jsonl"); }

// --- Types ---

export type TelemetryEventType =
  | "install"
  | "startup"
  | "update"
  | "audit_complete"
  | "setup_complete"
  | "error";

export interface TelemetryCommonFields {
  event: TelemetryEventType;
  version: string;
  source: "binary" | "plugin";
  os: string;
  arch: string;
  ci: boolean;
  mid: string;
  ts: string;
}

export type TelemetryEvent = TelemetryCommonFields & Record<string, unknown>;

/** Bounded vocabulary of error classes. Add new entries only when seen in the wild. */
export type ErrorClass =
  | "prompt_too_long"
  | "api_error"
  | "api_rate_limit"
  | "oauth_missing"
  | "network_error"
  | "timeout"
  | "parse_error"
  | "transcript_not_found"
  | "permission_denied"
  | "disk_full"
  | "config_invalid"
  | "unknown";

// --- Process state ---

let cachedMid: string | null = null;
let processStartupSent = false;
let cachedSource: "binary" | "plugin" | null = null;

// --- Opt-out ---

export function isTelemetryDisabled(): boolean {
  return !!(process.env.AXME_TELEMETRY_DISABLED || process.env.DO_NOT_TRACK);
}

// --- Source detection ---

/**
 * Detect whether axme-code is running as a Claude Code plugin or standalone binary.
 * Plugin context sets CLAUDE_PLUGIN_ROOT env var.
 */
export function detectSource(): "binary" | "plugin" {
  if (cachedSource) return cachedSource;
  cachedSource = process.env.CLAUDE_PLUGIN_ROOT ? "plugin" : "binary";
  return cachedSource;
}

// --- CI detection ---

export function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.BUILDKITE ||
    process.env.JENKINS_URL
  );
}

// --- Machine ID ---

/**
 * Read or generate the anonymous machine id.
 * - 64 hex chars (32 random bytes)
 * - Not derived from hardware
 * - Persisted at ~/.local/share/axme-code/machine-id with mode 0600
 * - On corrupted/unreadable file: regenerate (treated as new install)
 *
 * Returns { mid, isNew: true } when a fresh mid was generated.
 *
 * NOTE: When telemetry is disabled, this still generates an in-memory mid
 * but does NOT persist it to disk. This way callers (sendStartupEvents,
 * sendTelemetry) get a placeholder value but the user's machine state is
 * not modified by an opt-out installation.
 */
export function getOrCreateMid(): { mid: string; isNew: boolean } {
  if (cachedMid) return { mid: cachedMid, isNew: false };

  const disabled = isTelemetryDisabled();

  // Try to read existing mid
  if (existsSync(getMidFile())) {
    try {
      const raw = readFileSync(getMidFile(), "utf-8").trim();
      if (/^[0-9a-f]{64}$/.test(raw)) {
        cachedMid = raw;
        return { mid: raw, isNew: false };
      }
    } catch {
      // fall through to regenerate
    }
  }

  // Generate new mid
  const newMid = randomBytes(32).toString("hex");
  if (!disabled) {
    try {
      mkdirSync(getStateDir(), { recursive: true });
      writeFileSync(getMidFile(), newMid, "utf-8");
      try { chmodSync(getMidFile(), 0o600); } catch { /* non-fatal */ }
    } catch {
      // If we cannot persist, still return the in-memory mid for this process
    }
  }
  cachedMid = newMid;
  return { mid: newMid, isNew: true };
}

// --- Version tracking (for update detection) ---

export function readLastVersion(): string | null {
  try {
    if (!existsSync(getLastVersionFile())) return null;
    return readFileSync(getLastVersionFile(), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function writeLastVersion(version: string): void {
  try {
    mkdirSync(getStateDir(), { recursive: true });
    writeFileSync(getLastVersionFile(), version, "utf-8");
  } catch {
    // non-fatal
  }
}

// --- Common fields builder ---

function buildCommonFields(event: TelemetryEventType, mid: string): TelemetryCommonFields {
  return {
    event,
    version: AXME_CODE_VERSION,
    source: detectSource(),
    os: process.platform,
    arch: process.arch,
    ci: isCI(),
    mid,
    ts: new Date().toISOString(),
  };
}

// --- Send (with offline queue fallback) ---

function getEndpoint(): string {
  return process.env.AXME_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;
}

async function postEvents(events: TelemetryEvent[]): Promise<boolean> {
  const endpoint = getEndpoint();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

function readQueue(): TelemetryEvent[] {
  try {
    if (!existsSync(getQueueFile())) return [];
    const raw = readFileSync(getQueueFile(), "utf-8");
    const lines = raw.split("\n").filter(l => l.trim());
    const out: TelemetryEvent[] = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    return out;
  } catch {
    return [];
  }
}

function writeQueue(events: TelemetryEvent[]): void {
  try {
    mkdirSync(getStateDir(), { recursive: true });
    // Cap at QUEUE_MAX_EVENTS, drop oldest
    const capped = events.slice(-QUEUE_MAX_EVENTS);
    writeFileSync(getQueueFile(), capped.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  } catch {
    // non-fatal
  }
}

function appendToQueue(event: TelemetryEvent): void {
  try {
    mkdirSync(getStateDir(), { recursive: true });
    // Check current size — if over cap, rewrite trimmed
    if (existsSync(getQueueFile())) {
      const existing = readQueue();
      if (existing.length >= QUEUE_MAX_EVENTS) {
        existing.push(event);
        writeQueue(existing);
        return;
      }
    }
    appendFileSync(getQueueFile(), JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // non-fatal
  }
}

function clearQueue(): void {
  try { unlinkSync(getQueueFile()); } catch { /* non-fatal */ }
}

/**
 * Send a single telemetry event. Best-effort, fire-and-forget.
 *
 * Behavior:
 * - If telemetry disabled: no-op
 * - On send success: also flushes any queued events
 * - On send failure: appends to offline queue (capped at 100)
 *
 * Never throws, never blocks. Wraps everything in try/catch.
 */
export function sendTelemetry(
  event: TelemetryEventType,
  payload: Record<string, unknown> = {},
): void {
  if (isTelemetryDisabled()) return;
  // Run async, do not await
  setImmediate(() => {
    void sendTelemetryAsync(event, payload).catch(() => { /* swallow */ });
  });
}

/**
 * Send a telemetry event and AWAIT completion. Use this only on critical
 * exit paths (process.exit) where the fire-and-forget setImmediate from
 * sendTelemetry() would be killed before the network request lands.
 *
 * Same best-effort guarantees: never throws, falls back to offline queue
 * on failure. Returns when the send (or queue write) finishes.
 */
export async function sendTelemetryBlocking(
  event: TelemetryEventType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  if (isTelemetryDisabled()) return;
  try {
    await sendTelemetryAsync(event, payload);
  } catch { /* swallow */ }
}

async function sendTelemetryAsync(
  event: TelemetryEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { mid } = getOrCreateMid();
    const common = buildCommonFields(event, mid);
    const fullEvent: TelemetryEvent = { ...common, ...payload };

    // Try to send queued events along with the new one
    const queued = readQueue();
    const batch = [...queued, fullEvent].slice(-10); // batch limit per spec
    const ok = await postEvents(batch);

    if (ok) {
      // Success: clear queue if we shipped queued events
      if (queued.length > 0) clearQueue();
    } else {
      // Failure: queue this event for retry on next startup
      appendToQueue(fullEvent);
    }
  } catch {
    // swallow
  }
}

// --- Lifecycle helpers ---

/**
 * Send the install/startup/update events that happen at process startup.
 * Idempotent within a process: subsequent calls do nothing.
 *
 * Logic:
 * 1. If mid did not exist before this call → send `install`
 * 2. If last-version exists and differs from current → send `update`
 * 3. Always send `startup` (once per process)
 * 4. Update last-version file to current
 *
 * Awaitable. Callers should `await` it to ensure events are flushed before
 * heavy work begins. Under event-loop pressure (e.g. parallel LLM scanners),
 * fire-and-forget setImmediate callbacks may stall, causing fetch timeouts
 * that flag successful POSTs as failed and append them to the offline queue.
 * The next telemetry call then re-sends the queued events, producing
 * server-side duplicates. Awaiting startup sends sequentially avoids this.
 *
 * Failures during the network call are still swallowed silently — the
 * function never throws.
 */
export async function sendStartupEvents(): Promise<void> {
  if (isTelemetryDisabled()) return;
  if (processStartupSent) return;
  processStartupSent = true;

  try {
    const { isNew } = getOrCreateMid();
    const lastVersion = readLastVersion();
    const currentVersion = AXME_CODE_VERSION;

    if (isNew) {
      await sendTelemetryBlocking("install");
    }

    if (lastVersion && lastVersion !== currentVersion) {
      await sendTelemetryBlocking("update", { previous_version: lastVersion });
    }

    await sendTelemetryBlocking("startup");

    if (lastVersion !== currentVersion) {
      writeLastVersion(currentVersion);
    }
  } catch {
    // swallow
  }
}

// --- Phase 2: error helpers ---

/**
 * Map a caught exception to a bounded ErrorClass slug.
 * Never sends raw exception messages to telemetry — only the slug.
 */
export function classifyError(err: unknown): ErrorClass {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("prompt is too long") || msg.includes("max tokens") || msg.includes("context length")) return "prompt_too_long";
  if (msg.includes("rate limit") || msg.includes("429")) return "api_rate_limit";
  if (msg.includes("authentication") || msg.includes("api key") || msg.includes("apikey") || msg.includes("authtoken")) return "oauth_missing";
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted")) return "timeout";
  if (msg.includes("enoent") || msg.includes("transcript not found")) return "transcript_not_found";
  if (msg.includes("eacces") || msg.includes("permission denied")) return "permission_denied";
  if (msg.includes("enospc") || msg.includes("no space")) return "disk_full";
  if (msg.includes("network") || msg.includes("econnrefused") || msg.includes("fetch failed") || msg.includes("dns")) return "network_error";
  if (msg.includes("unexpected token") || msg.includes("invalid json") || msg.includes("parse")) return "parse_error";
  if (msg.includes("api error") || msg.includes("500") || msg.includes("503")) return "api_error";
  return "unknown";
}

/**
 * Report an error to telemetry with bounded category and class.
 */
export function reportError(
  category: "audit" | "setup" | "hook" | "mcp_tool" | "auto_update",
  errorClass: ErrorClass,
  fatal: boolean,
): void {
  sendTelemetry("error", { category, error_class: errorClass, fatal });
}

// --- Test helpers (exported for unit tests, not for production) ---

/** @internal Reset cached state. Used in tests only. */
export function _resetForTests(): void {
  cachedMid = null;
  processStartupSent = false;
  cachedSource = null;
}

/** @internal Get the resolved mid file path. Used in tests only. */
export function _getMidFilePath(): string {
  return getMidFile();
}

/** @internal Get the resolved queue file path. Used in tests only. */
export function _getQueueFilePath(): string {
  return getQueueFile();
}

/** @internal Get the resolved last-version file path. Used in tests only. */
export function _getLastVersionFilePath(): string {
  return getLastVersionFile();
}
