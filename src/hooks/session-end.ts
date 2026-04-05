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
import { readActiveSession, attachClaudeSession } from "../storage/sessions.js";
import { runSessionCleanup } from "../session-cleanup.js";
import { pathExists } from "../storage/engine.js";
import { AXME_CODE_DIR } from "../types.js";

interface SessionEndInput {
  session_id?: string;
  transcript_path?: string;
  source?: string;
}

async function handleSessionEnd(workspacePath: string, input: SessionEndInput): Promise<void> {
  if (!pathExists(join(workspacePath, AXME_CODE_DIR))) return;

  const sessionId = readActiveSession(workspacePath);
  if (!sessionId) return;

  // If Claude Code passes session_id + transcript_path in the SessionEnd
  // event, make sure it is attached before the audit runs. PreToolUse
  // should already have done this during the session, but a session that
  // only had read-only MCP tool calls (no Edit/Write, no PreToolUse-matched
  // tools) might not have been attached yet.
  if (input.session_id && input.transcript_path) {
    attachClaudeSession(workspacePath, sessionId, {
      id: input.session_id,
      transcriptPath: input.transcript_path,
      role: "main",
    });
  }

  await runSessionCleanup(workspacePath, sessionId, { clearActive: true });
}

/**
 * CLI entry point — reads JSON from stdin.
 * @param workspacePath - from --workspace CLI flag
 */
export async function runSessionEndHook(workspacePath?: string): Promise<void> {
  if (!workspacePath) return;

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    let input: SessionEndInput = {};
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as SessionEndInput;
    } catch {
      // Empty/invalid stdin is fine — we'll proceed without transcript attachment
    }
    await handleSessionEnd(workspacePath, input);
  } catch {
    // Hook failures must be silent
  }
}
