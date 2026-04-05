/**
 * Session Manager - tracks MCP server sessions.
 *
 * Location: .axme-code/sessions/<uuid>/meta.json
 * Active session pointer: .axme-code/active-session (contains UUID)
 *
 * Hooks use readActiveSession() to find the current session ID
 * instead of relying on Claude Code's session_id.
 */

import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ensureDir, writeJson, readJson, pathExists, atomicWrite, removeFile, readSafe } from "./engine.js";
import type { SessionMeta, ClaudeSessionRef } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

const SESSIONS_DIR = "sessions";
const ACTIVE_SESSION_FILE = "active-session";

function sessionsRoot(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, SESSIONS_DIR);
}

function activeSessionPath(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, ACTIVE_SESSION_FILE);
}

/**
 * Write the active session ID to .axme-code/active-session.
 * Hooks read this file to determine which session to write to.
 */
export function writeActiveSession(projectPath: string, sessionId: string): void {
  ensureDir(join(projectPath, AXME_CODE_DIR));
  atomicWrite(activeSessionPath(projectPath), sessionId);
}

/**
 * Read the active session ID from .axme-code/active-session.
 * Returns null if no active session.
 */
export function readActiveSession(projectPath: string): string | null {
  const content = readSafe(activeSessionPath(projectPath)).trim();
  return content || null;
}

/**
 * Remove the active-session pointer (called on process exit).
 */
export function clearActiveSession(projectPath: string): void {
  removeFile(activeSessionPath(projectPath));
}

export function initSessionStore(projectPath: string): void {
  ensureDir(sessionsRoot(projectPath));
}

export function createSession(projectPath: string): SessionMeta {
  initSessionStore(projectPath);
  const session: SessionMeta = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    closedAt: null,
    turns: 0,
    filesChanged: [],
    pid: process.pid,
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
 * Mark a session as audited by the LLM session auditor.
 * Used by both auto-audit (transport close) and startup fallback
 * to prevent duplicate audits on the same session.
 */
export function markAudited(projectPath: string, id: string): void {
  const session = loadSession(projectPath, id);
  if (!session) return;
  session.auditedAt = new Date().toISOString();
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
 * Find sessions that still need an LLM audit: auditedAt is null AND
 * their owning MCP server process is no longer running.
 *
 * Sessions without a pid field (pre-auto-audit format) are skipped —
 * we cannot determine if they are orphans without a PID to probe.
 *
 * Note: closedAt is intentionally NOT checked. A session may have
 * closedAt set but auditedAt null if its auto-audit failed — these
 * need a retry on the next startup.
 */
export function findOrphanSessions(projectPath: string): SessionMeta[] {
  const orphans: SessionMeta[] = [];
  for (const session of listSessions(projectPath)) {
    if (session.auditedAt) continue;
    if (session.pid == null) continue;
    if (isPidAlive(session.pid)) continue;
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
