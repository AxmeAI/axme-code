/**
 * SessionEnd hook — runs when Claude Code fires the SessionEnd lifecycle event.
 *
 * In practice this hook fires rarely and unreliably (especially in the VS Code
 * extension, where the MCP server is killed without the extension first running
 * SessionEnd — see anthropics/claude-code#1935 and #14760). The authoritative
 * cleanup path is the MCP server's own transport.onclose handler, which calls
 * the same `runSessionCleanup` function this hook does.
 *
 * The `auditedAt` dedup field ensures that whichever path runs first wins, and
 * the others become no-ops.
 *
 * Workspace path: passed via --workspace flag (hardcoded at setup time).
 * Session ID: read from .axme-code/active-session (if present).
 */

import { join } from "node:path";
import { readActiveSession } from "../storage/sessions.js";
import { runSessionCleanup } from "../session-cleanup.js";
import { pathExists } from "../storage/engine.js";
import { AXME_CODE_DIR } from "../types.js";

async function handleSessionEnd(workspacePath: string): Promise<void> {
  if (!pathExists(join(workspacePath, AXME_CODE_DIR))) return;

  const sessionId = readActiveSession(workspacePath);
  if (!sessionId) return;

  await runSessionCleanup(workspacePath, sessionId, { clearActive: true });
}

/**
 * CLI entry point — reads JSON from stdin.
 * @param workspacePath - from --workspace CLI flag
 */
export async function runSessionEndHook(workspacePath?: string): Promise<void> {
  if (!workspacePath) return;

  try {
    // Still consume stdin (Claude Code sends it), but we don't need its content
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    await handleSessionEnd(workspacePath);
  } catch {
    // Hook failures must be silent
  }
}
