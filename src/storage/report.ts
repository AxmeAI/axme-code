/**
 * Session Report - markdown report generation from session activity.
 *
 * Location: .axme-code/sessions/<id>/report.md
 */

import { join } from "node:path";
import { atomicWrite, readSafe, ensureDir, appendLine } from "./engine.js";
import { AXME_CODE_DIR } from "../types.js";

const SESSIONS_DIR = "sessions";

function sessionDir(projectPath: string, sessionId: string): string {
  return join(projectPath, AXME_CODE_DIR, SESSIONS_DIR, sessionId);
}

/**
 * Append a line to the session report.
 */
export function appendReport(projectPath: string, sessionId: string, line: string): void {
  const dir = sessionDir(projectPath, sessionId);
  ensureDir(dir);
  appendLine(join(dir, "report.md"), line);
}

/**
 * Read the full session report.
 */
export function readReport(projectPath: string, sessionId: string): string {
  return readSafe(join(sessionDir(projectPath, sessionId), "report.md"));
}

/**
 * Save an artifact file in the session directory.
 */
export function saveArtifact(projectPath: string, sessionId: string, filename: string, content: string): void {
  const dir = sessionDir(projectPath, sessionId);
  ensureDir(dir);
  atomicWrite(join(dir, filename), content);
}

/**
 * Format a report header for an agent step.
 */
export function formatAgentHeader(agent: string, task: string): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  return `\n## ${agent} (${ts})\n\n**Task:** ${task}\n`;
}

/**
 * Format token counts for display.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
