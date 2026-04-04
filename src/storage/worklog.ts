/**
 * Worklog - append-only JSONL event log.
 *
 * Location: .axme-code/worklog.jsonl
 * Format: one JSON event per line, newest last.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLine, pathExists } from "./engine.js";
import type { WorklogEvent, WorklogEventType } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

const WORKLOG_FILE = "worklog.jsonl";

function worklogPath(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, WORKLOG_FILE);
}

/**
 * Append an event to the worklog.
 */
export function logEvent(
  projectPath: string,
  type: WorklogEventType,
  sessionId: string,
  data: Record<string, unknown> = {},
): void {
  const event: WorklogEvent = {
    timestamp: new Date().toISOString(),
    type,
    sessionId,
    data,
  };
  appendLine(worklogPath(projectPath), JSON.stringify(event));
}

/**
 * Read worklog events, newest first.
 */
export function readWorklog(
  projectPath: string,
  opts?: { limit?: number; type?: WorklogEventType },
): WorklogEvent[] {
  const path = worklogPath(projectPath);
  if (!pathExists(path)) return [];

  const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
  let events: WorklogEvent[] = lines
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e): e is WorklogEvent => e !== null);

  if (opts?.type) events = events.filter(e => e.type === opts.type);
  events.reverse(); // newest first
  if (opts?.limit) return events.slice(0, opts.limit);
  return events;
}

/**
 * Format worklog events for display.
 */
export function showWorklog(projectPath: string, limit: number = 20): string {
  const events = readWorklog(projectPath, { limit });
  if (events.length === 0) return "No worklog events.";

  return events.map(e => {
    const ts = e.timestamp.replace("T", " ").slice(0, 19);
    const dataStr = Object.entries(e.data)
      .filter(([_, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    return `[${ts}] ${e.type} ${dataStr}`;
  }).join("\n");
}

// --- Convenience loggers ---

export function logSessionStart(projectPath: string, sessionId: string): void {
  logEvent(projectPath, "session_start", sessionId);
}

export function logSessionEnd(projectPath: string, sessionId: string, data?: Record<string, unknown>): void {
  logEvent(projectPath, "session_end", sessionId, data);
}

export function logCheckResult(
  projectPath: string,
  sessionId: string,
  agent: string,
  result: string,
  details?: string,
): void {
  logEvent(projectPath, "check_result", sessionId, { agent, result, details });
}

export function logMemorySaved(
  projectPath: string,
  sessionId: string,
  slug: string,
  type: string,
): void {
  logEvent(projectPath, "memory_saved", sessionId, { slug, type });
}

export function logError(projectPath: string, sessionId: string, error: string): void {
  logEvent(projectPath, "error", sessionId, { error });
}
