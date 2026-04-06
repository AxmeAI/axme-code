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

export function logSessionEnd(
  projectPath: string, sessionId: string,
  data?: { filesCount?: number; auditRan?: boolean },
): void {
  logEvent(projectPath, "session_end", sessionId, data ?? {});
}

export function logSafetyBlock(
  projectPath: string, sessionId: string,
  tool: string, target: string, rule: string, reason: string,
): void {
  logEvent(projectPath, "safety_block", sessionId, { tool, target, rule, reason });
}

export function logAuditComplete(
  projectPath: string, sessionId: string,
  data: { costUsd: number; memories: number; decisions: number; safety: number; durationMs: number },
): void {
  logEvent(projectPath, "audit_complete", sessionId, data);
}

export function logDecisionSaved(
  projectPath: string, sessionId: string,
  id: string, title: string, source: string,
): void {
  logEvent(projectPath, "decision_saved", sessionId, { id, title, source });
}

export function logDecisionSuperseded(
  projectPath: string, sessionId: string,
  oldId: string, newId: string,
): void {
  logEvent(projectPath, "decision_superseded", sessionId, { oldId, newId });
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

/**
 * Parse worklog stats for CLI display.
 */
export function worklogStats(projectPath: string): {
  totalSessions: number;
  totalAudits: number;
  totalCostUsd: number;
  safetyBlocks: Array<{ tool: string; target: string; reason: string; timestamp: string }>;
  recentErrors: Array<{ error: string; timestamp: string }>;
} {
  const events = readWorklog(projectPath);
  let totalSessions = 0;
  let totalAudits = 0;
  let totalCostUsd = 0;
  const safetyBlocks: Array<{ tool: string; target: string; reason: string; timestamp: string }> = [];
  const recentErrors: Array<{ error: string; timestamp: string }> = [];

  for (const e of events) {
    switch (e.type) {
      case "session_start":
        totalSessions++;
        break;
      case "audit_complete":
        totalAudits++;
        totalCostUsd += (e.data.costUsd as number) ?? 0;
        break;
      case "safety_block":
        safetyBlocks.push({
          tool: e.data.tool as string,
          target: e.data.target as string,
          reason: e.data.reason as string,
          timestamp: e.timestamp,
        });
        break;
      case "error":
        recentErrors.push({
          error: e.data.error as string,
          timestamp: e.timestamp,
        });
        break;
    }
  }

  return { totalSessions, totalAudits, totalCostUsd, safetyBlocks, recentErrors: recentErrors.slice(0, 10) };
}
