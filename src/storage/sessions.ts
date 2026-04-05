/**
 * Session Manager — tracks MCP server sessions.
 *
 * Layout:
 *   .axme-code/sessions/<axme-uuid>/meta.json          — session metadata
 *   .axme-code/active-sessions/<claude-session-id>.txt — maps a Claude Code
 *                                                         session to its AXME
 *                                                         UUID
 *
 * Multi-window safety: each VS Code window has its own Claude session_id and
 * therefore its own mapping file. Hooks receive `session_id` from Claude Code
 * in stdin and use it to look up the right AXME session — no last-writer-wins.
 *
 * Legacy: before this change, a single `.axme-code/active-session` file held
 * the current AXME UUID. That file is now stale by definition; the MCP server
 * deletes it on startup.
 */

import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ensureDir, writeJson, readJson, pathExists, atomicWrite, removeFile, readSafe } from "./engine.js";
import type { SessionMeta, ClaudeSessionRef } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

const SESSIONS_DIR = "sessions";
const ACTIVE_SESSIONS_DIR = "active-sessions";
const AUDIT_LOGS_DIR = "audit-logs";
const LEGACY_ACTIVE_SESSION_FILE = "active-session";
const LEGACY_PENDING_AUDITS_DIR = "pending-audits";

/**
 * Stale timeout for "pending" audit status. If a session has been marked as
 * auditStatus=pending for longer than this, we assume the auditor process
 * crashed without releasing the status and allow a new audit to proceed.
 *
 * This is the cross-process recovery mechanism that replaces the old
 * pending-audits/ marker files + auditorPid probe. No file locks needed:
 * saveScopedMemories/Decisions already dedup by slug, so even the (rare)
 * micro race window between two audits starting simultaneously can only
 * waste LLM cost on duplicate extraction — it cannot corrupt stored data.
 */
export const AUDIT_STALE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Find the real Claude Code process ID that owns this hook/MCP invocation.
 *
 * Claude Code wraps hook commands in `sh -c 'axme-code hook ...'`, which
 * means `process.ppid` in a hook subprocess equals the (usually already-
 * dead) sh wrapper PID, not the Claude Code PID. Using that wrong PID for
 * ownership tracking caused live sessions to be marked "orphaned" and
 * prematurely closed in PR#6's E2E verification (Bug A).
 *
 * We walk one step up the process tree by reading `/proc/<ppid>/stat`:
 *
 *   pid (comm) state ppid pgrp session ...
 *                     ^^^^
 *                     grandparent = real Claude Code PID
 *
 * `comm` can contain spaces and parens, so we find the LAST ")" and parse
 * fields after it. `parts[1]` is the ppid of our parent = our grandparent.
 *
 * On non-Linux systems /proc does not exist; we fall back to `process.ppid`
 * (broken on macOS under sh wrapping, acceptable for now — primary target
 * is Linux where Claude Code wraps hooks via sh).
 *
 * The MCP server itself is spawned directly by Claude Code without an sh
 * wrapper, so its `process.ppid` is already the real Claude Code PID —
 * this helper is mainly needed in hook subprocesses. Calling it from the
 * MCP server is still safe: the /proc walk would return Claude Code's own
 * parent (VS Code / the terminal), which we never use; the function is
 * called only from hook contexts (writeClaudeSessionMapping, createSession
 * via ensureAxmeSessionForClaude).
 */
export function getClaudeCodePid(): number {
  try {
    const stat = readFileSync(`/proc/${process.ppid}/stat`, "utf-8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen > 0) {
      // Fields after "(comm) " are space-separated: state ppid pgrp ...
      const parts = stat.slice(closeParen + 2).split(" ");
      const grandparent = parseInt(parts[1], 10);
      if (Number.isFinite(grandparent) && grandparent > 1) return grandparent;
    }
  } catch {
    // /proc missing (macOS, Windows), or parent died before we could read
    // its stat file. Fall through to fallback.
  }
  return process.ppid;
}

function sessionsRoot(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, SESSIONS_DIR);
}

function activeSessionsDir(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, ACTIVE_SESSIONS_DIR);
}

function activeMappingPath(projectPath: string, claudeSessionId: string): string {
  return join(activeSessionsDir(projectPath), `${claudeSessionId}.txt`);
}

function legacyActiveSessionPath(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, LEGACY_ACTIVE_SESSION_FILE);
}

function legacyPendingAuditsDir(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, LEGACY_PENDING_AUDITS_DIR);
}

function auditLogsDir(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, AUDIT_LOGS_DIR);
}

function auditLogPath(projectPath: string, axmeSessionId: string, startedAt: string): string {
  // Filename: <iso-date>_<short-axme-id>.json  (sortable, human-scannable)
  const datePart = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  return join(auditLogsDir(projectPath), `${datePart}_${axmeSessionId.slice(0, 8)}.json`);
}

// --- Audit logs (permanent per-audit record) ---

export interface AuditLogExtraction {
  type: "memory" | "decision" | "safety";
  slug?: string;
  title?: string;
  ruleType?: string;
  value?: string;
  scope?: string[];
  proposedRoutes: string[]; // e.g. ["workspace/.axme-code/memory/"]
  status: "saved" | "deduped" | "dropped";
  reason?: string; // for deduped/dropped
}

export interface AuditLog {
  axmeSessionId: string;
  claudeSessionIds: string[];
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  phase: "started" | "chunking" | "saving" | "finished" | "failed";
  model?: string;
  chunks?: number;
  promptTokens?: number;
  costUsd?: number;
  filesChangedCount?: number;
  extractions?: AuditLogExtraction[];
  error?: string;
  // Counters rolled up from extractions
  totals?: {
    memoriesExtracted: number;
    memoriesSaved: number;
    memoriesDeduped: number;
    decisionsExtracted: number;
    decisionsSaved: number;
    decisionsDeduped: number;
    safetyExtracted: number;
    safetySaved: number;
    safetyDeduped: number;
  };
}

/**
 * Write a new audit log file at the start of an audit. Returns the file path
 * so callers can update it later with appendAuditLog (same filename).
 */
export function writeAuditLog(projectPath: string, log: AuditLog): string {
  ensureDir(auditLogsDir(projectPath));
  const path = auditLogPath(projectPath, log.axmeSessionId, log.startedAt);
  atomicWrite(path, JSON.stringify(log, null, 2));
  return path;
}

/**
 * Merge updates into an existing audit log file. No-op if the file is missing.
 */
export function updateAuditLog(path: string, updates: Partial<AuditLog>): void {
  try {
    const existing = readJson<AuditLog>(path);
    if (!existing) return;
    const merged: AuditLog = { ...existing, ...updates };
    atomicWrite(path, JSON.stringify(merged, null, 2));
  } catch {}
}

// --- Pending-audits legacy cleanup ---
//
// Previous versions wrote per-session marker files to .axme-code/pending-audits/
// to flag in-progress audits. Those files were fragile (auditor crashes could
// leave stale markers behind, and a separate directory added coordination cost)
// and have been replaced by the `auditStatus` field on SessionMeta. The helper
// below removes any leftover directory so stale markers don't confuse operators.
// Safe to call repeatedly.

export function clearLegacyPendingAuditsDir(projectPath: string): void {
  const dir = legacyPendingAuditsDir(projectPath);
  if (!pathExists(dir)) return;
  try {
    for (const entry of readdirSync(dir)) {
      removeFile(join(dir, entry));
    }
  } catch {}
  // Best-effort rmdir via removeFile (no-op if not empty, which is fine).
  try { removeFile(dir); } catch {}
}

/**
 * Find sessions whose audit is currently running (auditStatus === "pending")
 * and has not yet exceeded the stale timeout. Returned entries represent
 * audits that a concurrently-starting new session should wait for or warn
 * about before trusting the knowledge base.
 *
 * This replaces the old pending-audits/ directory scan. All state now lives
 * on SessionMeta, so a single listSessions() call gives us everything.
 */
export interface PendingAuditEntry {
  sessionId: string;
  startedAt: string;
  phase: "running";
  /** Raw SessionMeta so callers can show turn counts, etc. if desired. */
  session: SessionMeta;
}

export function listPendingAudits(projectPath: string): PendingAuditEntry[] {
  const now = Date.now();
  const out: PendingAuditEntry[] = [];
  for (const session of listSessions(projectPath)) {
    if (session.auditStatus !== "pending") continue;
    if (!session.auditStartedAt) continue;
    const startedMs = Date.parse(session.auditStartedAt);
    if (!Number.isFinite(startedMs)) continue;
    if (now - startedMs > AUDIT_STALE_TIMEOUT_MS) continue; // stale — caller ignores
    out.push({
      sessionId: session.id,
      startedAt: session.auditStartedAt,
      phase: "running",
      session,
    });
  }
  return out;
}

/**
 * Mapping file format: JSON with the AXME session UUID and the hook's ppid
 * (parent process id, which equals the Claude Code process PID that spawned
 * the hook). MCP servers running under the same Claude Code process share
 * the same ppid with their hooks, so `ownerPpid` lets a disconnecting MCP
 * server identify exactly which mapping files belong to its Claude Code.
 */
interface MappingFileContent {
  axmeSessionId: string;
  ownerPpid?: number;
}

/**
 * Write the Claude-session → AXME-session mapping file.
 * Called by hooks when they first see a Claude session_id.
 *
 * `ownerPpid` must equal the Claude Code PID that spawned both this hook
 * subprocess AND the MCP server in the same window, so the MCP server's
 * disconnect handler can identify its own mappings by PID equality.
 * Claude Code wraps hooks via `sh -c 'axme-code hook ...'`, so a raw
 * `process.ppid` would give us the (usually dead) sh wrapper PID — we walk
 * one step up via getClaudeCodePid() to reach the real Claude Code PID.
 */
export function writeClaudeSessionMapping(
  projectPath: string,
  claudeSessionId: string,
  axmeSessionId: string,
): void {
  ensureDir(activeSessionsDir(projectPath));
  const payload: MappingFileContent = {
    axmeSessionId,
    ownerPpid: getClaudeCodePid(),
  };
  atomicWrite(activeMappingPath(projectPath, claudeSessionId), JSON.stringify(payload));
}

/**
 * Look up the AXME session for a given Claude session_id.
 * Returns null if no mapping exists.
 *
 * Supports both the new JSON format and the legacy plain-UUID format,
 * so mapping files written by older versions still work.
 */
export function readClaudeSessionMapping(
  projectPath: string,
  claudeSessionId: string,
): string | null {
  const raw = readSafe(activeMappingPath(projectPath, claudeSessionId)).trim();
  if (!raw) return null;
  // Try JSON first (new format)
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as MappingFileContent;
      return parsed.axmeSessionId || null;
    } catch {
      return null;
    }
  }
  // Legacy format: plain UUID
  return raw;
}

/**
 * Read the full mapping file including the ownerPpid. Used by the MCP
 * server at disconnect time to identify its own mappings.
 */
export function readClaudeSessionMappingFull(
  projectPath: string,
  claudeSessionId: string,
): MappingFileContent | null {
  const raw = readSafe(activeMappingPath(projectPath, claudeSessionId)).trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw) as MappingFileContent;
    } catch {
      return null;
    }
  }
  // Legacy plain-UUID format — no ownerPpid available.
  return { axmeSessionId: raw };
}

/**
 * Remove the mapping for a specific Claude session (e.g. when its AXME session
 * is closed).
 */
export function clearClaudeSessionMapping(
  projectPath: string,
  claudeSessionId: string,
): void {
  removeFile(activeMappingPath(projectPath, claudeSessionId));
}

/**
 * List all current Claude → AXME mappings in the active-sessions directory.
 * Used by the MCP server at disconnect time to find its own sessions
 * (filtered by ownerPpid) and by startup fallback to detect stale mappings.
 */
export function listClaudeSessionMappings(
  projectPath: string,
): Array<{ claudeSessionId: string; axmeSessionId: string; ownerPpid?: number }> {
  const dir = activeSessionsDir(projectPath);
  if (!pathExists(dir)) return [];
  const result: Array<{ claudeSessionId: string; axmeSessionId: string; ownerPpid?: number }> = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".txt")) continue;
      const claudeSessionId = entry.slice(0, -4);
      const mapping = readClaudeSessionMappingFull(projectPath, claudeSessionId);
      if (mapping?.axmeSessionId) {
        result.push({
          claudeSessionId,
          axmeSessionId: mapping.axmeSessionId,
          ownerPpid: mapping.ownerPpid,
        });
      }
    }
  } catch {}
  return result;
}

/**
 * Delete the legacy single-file active-session marker if it exists.
 * Called by MCP server startup so old servers' stale markers don't confuse
 * anything. Safe to call repeatedly.
 */
export function clearLegacyActiveSession(projectPath: string): void {
  removeFile(legacyActiveSessionPath(projectPath));
}

/**
 * Ensure an AXME session exists for the given Claude session. Lazy-created
 * on the first hook call that knows its Claude session_id. Subsequent calls
 * for the same Claude session return the existing mapping.
 *
 * Also attaches the Claude session (id + transcript path) to the AXME session
 * so the auditor can later read the transcript.
 *
 * Returns the AXME session UUID.
 */
export function ensureAxmeSessionForClaude(
  projectPath: string,
  claudeSessionId: string,
  transcriptPath: string,
): string {
  const existing = readClaudeSessionMapping(projectPath, claudeSessionId);
  if (existing) {
    // Ensure the transcript is attached (idempotent).
    attachClaudeSession(projectPath, existing, {
      id: claudeSessionId,
      transcriptPath,
      role: "main",
    });
    return existing;
  }
  const axmeSession = createSession(projectPath);
  writeClaudeSessionMapping(projectPath, claudeSessionId, axmeSession.id);
  attachClaudeSession(projectPath, axmeSession.id, {
    id: claudeSessionId,
    transcriptPath,
    role: "main",
  });
  return axmeSession.id;
}

// --- Legacy single-file API (DEPRECATED, kept for backward compatibility) ---
//
// The following functions operate on the old `.axme-code/active-session` file.
// They are no longer called by hooks or the server — hooks use the Claude
// session_id lookup (readClaudeSessionMapping) and the server uses
// clearLegacyActiveSession on startup. These shims exist only so that any
// external code still calling them does not break outright.

/** @deprecated Use writeClaudeSessionMapping. */
export function writeActiveSession(projectPath: string, sessionId: string): void {
  ensureDir(join(projectPath, AXME_CODE_DIR));
  atomicWrite(legacyActiveSessionPath(projectPath), sessionId);
}

/** @deprecated Use readClaudeSessionMapping. */
export function readActiveSession(projectPath: string): string | null {
  const content = readSafe(legacyActiveSessionPath(projectPath)).trim();
  return content || null;
}

/** @deprecated Use clearClaudeSessionMapping. */
export function clearActiveSession(projectPath: string): void {
  removeFile(legacyActiveSessionPath(projectPath));
}

export function initSessionStore(projectPath: string): void {
  ensureDir(sessionsRoot(projectPath));
}

/**
 * Create a new AXME session.
 *
 * `pid` is set to the Claude Code PID that owns this work. This function is
 * called only from `ensureAxmeSessionForClaude`, which itself runs inside
 * hook subprocesses — those subprocesses are wrapped in `sh -c '...'` by
 * Claude Code, so their direct `process.ppid` is the sh wrapper (usually
 * already exited) rather than the Claude Code process. We walk one step up
 * via getClaudeCodePid() to record the real Claude Code PID.
 *
 * When Claude Code dies, the session becomes an orphan and findOrphanSessions
 * picks it up via isPidAlive(pid) returning false.
 */
export function createSession(projectPath: string): SessionMeta {
  initSessionStore(projectPath);
  const session: SessionMeta = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    closedAt: null,
    turns: 0,
    filesChanged: [],
    pid: getClaudeCodePid(),
  };
  writeSession(projectPath, session);
  return session;
}

export function loadSession(projectPath: string, id: string): SessionMeta | null {
  return readJson<SessionMeta>(join(sessionsRoot(projectPath), id, "meta.json"));
}

export function writeSession(projectPath: string, session: SessionMeta): void {
  const dir = join(sessionsRoot(projectPath), session.id);
  ensureDir(dir);
  writeJson(join(dir, "meta.json"), session);
}

export function closeSession(projectPath: string, id: string): void {
  const session = loadSession(projectPath, id);
  if (!session) return;
  session.closedAt = new Date().toISOString();
  writeSession(projectPath, session);
}

/**
 * Mark a session as successfully audited by the LLM session auditor.
 * Used by both auto-audit (transport close) and startup fallback to prevent
 * duplicate audits on the same session. Also finalizes the audit lifecycle
 * flags: auditStatus=done, auditFinishedAt, and clears any stale lastAuditError
 * from a prior failed attempt.
 */
export function markAudited(projectPath: string, id: string): void {
  const session = loadSession(projectPath, id);
  if (!session) return;
  const now = new Date().toISOString();
  session.auditedAt = now;
  session.auditStatus = "done";
  session.auditFinishedAt = now;
  session.lastAuditError = undefined;
  writeSession(projectPath, session);
}

/**
 * Check if a process with the given PID is currently running.
 * Uses signal 0 (no-op signal) to probe process existence.
 *
 * Returns true if process is alive, false if dead.
 * EPERM (permission denied) is treated as alive — the process exists
 * but belongs to another user, which is extremely rare in our context
 * and safer to treat as alive than as dead.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "EPERM") return true;
    return false;
  }
}

/**
 * Maximum number of audit attempts on a single session. After this many
 * failures, the session is no longer retried by orphan cleanup — it stays
 * in storage with `lastAuditError` set for manual inspection.
 *
 * Set to 1 on purpose: if the audit fails once, retrying won't help (the
 * root cause is deterministic — prompt too large, parser rejection, etc.).
 * Retry loops hide bugs instead of surfacing them.
 */
export const MAX_AUDIT_ATTEMPTS = 1;

/**
 * Find sessions that still need an LLM audit: auditedAt is null AND
 * their owning MCP server process is no longer running AND they have
 * not already hit the retry cap.
 *
 * Sessions without a pid field (pre-auto-audit format) are skipped —
 * we cannot determine if they are orphans without a PID to probe.
 *
 * Sessions with auditAttempts >= MAX_AUDIT_ATTEMPTS are skipped — they
 * failed once and we don't retry. Operators can force-re-audit manually
 * by clearing auditAttempts on the session meta.
 */
export function findOrphanSessions(projectPath: string): SessionMeta[] {
  const orphans: SessionMeta[] = [];
  for (const session of listSessions(projectPath)) {
    if (session.auditedAt) continue;
    if (session.pid == null) continue;
    if (isPidAlive(session.pid)) continue;
    if ((session.auditAttempts ?? 0) >= MAX_AUDIT_ATTEMPTS) continue;
    orphans.push(session);
  }
  return orphans;
}

export function listSessions(projectPath: string, opts?: { limit?: number }): SessionMeta[] {
  const root = sessionsRoot(projectPath);
  const sessions: SessionMeta[] = [];

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const session = readJson<SessionMeta>(join(root, entry.name, "meta.json"));
      if (session) sessions.push(session);
    }
  } catch {}

  sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (opts?.limit) return sessions.slice(0, opts.limit);
  return sessions;
}

export function getLastSession(projectPath: string): SessionMeta | null {
  const sessions = listSessions(projectPath, { limit: 1 });
  return sessions[0] ?? null;
}

/**
 * Track a file change in an existing session.
 *
 * Called from the PostToolUse hook, which runs in a separate process from
 * the MCP server. If the session file cannot be read (transient I/O error
 * or missing), this function silently returns instead of creating a new
 * session — recreating would destroy the real session's turns counter and
 * filesChanged list. Losing a single filesChanged entry is a far better
 * tradeoff than resetting the session to turns=0.
 */
export function trackFileChanged(projectPath: string, sessionId: string, filePath: string): void {
  const session = loadSession(projectPath, sessionId);
  if (!session) return;
  if (!session.filesChanged.includes(filePath)) {
    session.filesChanged.push(filePath);
    writeSession(projectPath, session);
  }
}

/**
 * Attach a Claude Code session (from a hook event) to an AXME session.
 *
 * Called from hooks on every tool call. The first call records the Claude
 * Code session_id and transcript path; subsequent calls are dedup'd by id.
 *
 * The session auditor uses this list to locate transcript files for the
 * audit. Multi-agent scenarios (tester, reviewer) will attach additional
 * Claude sessions to the same AXME session via the same mechanism.
 *
 * Silent no-op if the session cannot be read — the MCP server may be mid-
 * shutdown or the meta file may be under concurrent write.
 */
export function attachClaudeSession(
  projectPath: string,
  axmeSessionId: string,
  ref: { id: string; transcriptPath: string; role?: string },
): void {
  if (!ref.id || !ref.transcriptPath) return;
  const session = loadSession(projectPath, axmeSessionId);
  if (!session) return;
  if (!session.claudeSessions) session.claudeSessions = [];
  if (session.claudeSessions.some(c => c.id === ref.id)) return;
  const entry: ClaudeSessionRef = {
    id: ref.id,
    transcriptPath: ref.transcriptPath,
    firstSeen: new Date().toISOString(),
    ...(ref.role ? { role: ref.role } : {}),
  };
  session.claudeSessions.push(entry);
  writeSession(projectPath, session);
}

export function incrementTurns(projectPath: string, sessionId: string): void {
  const session = loadSession(projectPath, sessionId);
  if (!session) return;
  session.turns++;
  writeSession(projectPath, session);
}
