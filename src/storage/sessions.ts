/**
 * Session Manager - tracks MCP server sessions.
 *
 * Location: .axme-code/sessions/<uuid>/meta.json
 */

import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ensureDir, writeJson, readJson, pathExists } from "./engine.js";
import type { SessionMeta } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

const SESSIONS_DIR = "sessions";

function sessionsRoot(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, SESSIONS_DIR);
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

export function trackFileChanged(projectPath: string, sessionId: string, filePath: string): void {
  const session = loadSession(projectPath, sessionId);
  if (!session) return;
  if (!session.filesChanged.includes(filePath)) {
    session.filesChanged.push(filePath);
    writeSession(projectPath, session);
  }
}

export function incrementTurns(projectPath: string, sessionId: string): void {
  const session = loadSession(projectPath, sessionId);
  if (!session) return;
  session.turns++;
  writeSession(projectPath, session);
}
