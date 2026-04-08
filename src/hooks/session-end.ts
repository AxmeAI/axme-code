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
import {
  ensureAxmeSessionForClaude,
  readClaudeSessionMapping,
  clearClaudeSessionMapping,
} from "../storage/sessions.js";
import { spawnDetachedAuditWorker } from "../audit-spawner.js";
import { pathExists } from "../storage/engine.js";
import { AXME_CODE_DIR } from "../types.js";

interface SessionEndInput {
  session_id?: string;
  transcript_path?: string;
  source?: string;
}

function handleSessionEnd(workspacePath: string, input: SessionEndInput): void {
  if (!pathExists(join(workspacePath, AXME_CODE_DIR))) return;

  // SessionEnd must know which Claude session is ending. If it does not,
  // there is nothing we can safely do — we cannot guess which of possibly
  // several parallel sessions is closing.
  if (!input.session_id) return;

  // If PreToolUse / PostToolUse already created the AXME session for this
  // Claude session, we find it via the mapping. If not (e.g. the session
  // only made read-only MCP tool calls), create it now so the audit still
  // runs against whatever filesChanged/worklog we have.
  let axmeSessionId = readClaudeSessionMapping(workspacePath, input.session_id);
  if (!axmeSessionId && input.transcript_path) {
    axmeSessionId = ensureAxmeSessionForClaude(
      workspacePath,
      input.session_id,
      input.transcript_path,
    );
  }
  if (!axmeSessionId) return;

  // Spawn a detached audit worker and return immediately. The worker lives
  // in its own process group and survives SIGKILL to Claude Code / the hook
  // subprocess. We do NOT await runSessionCleanup here — the hook's 120s
  // timeout and Claude Code's shutdown clock together make synchronous
  // auditing unreliable in practice.
  spawnDetachedAuditWorker(workspacePath, axmeSessionId);
  // Clear this Claude session's mapping file — the session is over.
  clearClaudeSessionMapping(workspacePath, input.session_id);
}

/**
 * CLI entry point — reads JSON from stdin.
 * @param workspacePath - from --workspace CLI flag
 */
export async function runSessionEndHook(workspacePath?: string): Promise<void> {
  if (!workspacePath) workspacePath = process.cwd();
  if (!workspacePath) return;

  // Skip entirely when running inside a subclaude audit worker (see
  // session-auditor env: { ...process.env, AXME_SKIP_HOOKS: "1" }). Without
  // this, a subclaude that exits mid-audit could trigger SessionEnd against
  // an ephemeral Claude session id and recursively invoke runSessionCleanup
  // on a ghost AXME session (Bug F from PR#6 E2E).
  if (process.env.AXME_SKIP_HOOKS === "1") return;

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    let input: SessionEndInput = {};
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as SessionEndInput;
    } catch {
      // Empty/invalid stdin is fine — we'll proceed without transcript attachment
    }
    handleSessionEnd(workspacePath, input);
  } catch {
    // Hook failures must be silent
  }
}
