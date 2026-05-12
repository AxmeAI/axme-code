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
import { loadAuditorMode } from "../utils/auditor-mode.js";
import { pathExists } from "../storage/engine.js";
import { AXME_CODE_DIR } from "../types.js";
import type { IdeKind } from "../types.js";
import { claudeCodeInputAdapter } from "./adapters/claude-code.js";
import { cursorInputAdapter } from "./adapters/cursor.js";
import type { HookInputAdapter, NormalizedHookEvent } from "./adapters/types.js";

function inputAdapterFor(ide: IdeKind): HookInputAdapter {
  return ide === "cursor" ? cursorInputAdapter : claudeCodeInputAdapter;
}

function handleSessionEnd(workspacePath: string, event: NormalizedHookEvent): void {
  if (!pathExists(join(workspacePath, AXME_CODE_DIR))) return;

  // Auditor-mode gate (v0.0.3+). When the user has opted into cooperative
  // mode in the Cursor extension sidebar, memories/decisions are saved
  // inline by the agent during chat — no detached background LLM should
  // fire and burn separately-billed tokens. "off" disables extraction
  // entirely. "background" preserves the historical (CLI-default) flow.
  const auditorMode = loadAuditorMode();
  if (auditorMode !== "background") return;

  // SessionEnd must know which IDE session is ending. If it does not,
  // there is nothing we can safely do — we cannot guess which of possibly
  // several parallel sessions is closing.
  if (!event.sessionId) return;

  // If PreToolUse / PostToolUse already created the AXME session for this
  // IDE session, we find it via the mapping. If not (e.g. the session only
  // made read-only MCP tool calls), create it now so the audit still runs
  // against whatever filesChanged/worklog we have.
  let axmeSessionId = readClaudeSessionMapping(workspacePath, event.sessionId);
  if (!axmeSessionId && event.transcriptPath) {
    axmeSessionId = ensureAxmeSessionForClaude(
      workspacePath,
      event.sessionId,
      event.transcriptPath,
      undefined,
      event.ide,
    );
  }
  if (!axmeSessionId) return;

  // Spawn a detached audit worker and return immediately. The worker lives
  // in its own process group and survives SIGKILL to the IDE / the hook
  // subprocess. We do NOT await runSessionCleanup here — the hook's 120s
  // timeout and the IDE's shutdown clock together make synchronous auditing
  // unreliable in practice.
  spawnDetachedAuditWorker(workspacePath, axmeSessionId, event.ide);
  // Clear this IDE session's mapping file — the session is over.
  clearClaudeSessionMapping(workspacePath, event.sessionId);
}

/**
 * CLI entry point — reads JSON from stdin.
 * @param workspacePath - from --workspace CLI flag
 * @param ide - from --ide CLI flag (defaults to "claude-code")
 */
export async function runSessionEndHook(workspacePath?: string, ide: IdeKind = "claude-code"): Promise<void> {
  // Skip entirely when running inside a subclaude audit worker (see
  // session-auditor env: { ...process.env, AXME_SKIP_HOOKS: "1" }). Without
  // this, a subclaude that exits mid-audit could trigger SessionEnd against
  // an ephemeral Claude session id and recursively invoke runSessionCleanup
  // on a ghost AXME session (Bug F from PR#6 E2E).
  if (process.env.AXME_SKIP_HOOKS === "1") return;

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    let raw: unknown = {};
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      // Empty/invalid stdin is fine — we'll proceed without transcript attachment
    }

    // Resolve workspace path: explicit --workspace flag > stdin
    // workspace_roots[0] > process.cwd(). See pre-tool-use.ts for rationale.
    if (!workspacePath) {
      const roots = (raw as { workspace_roots?: unknown })?.workspace_roots;
      if (Array.isArray(roots) && typeof roots[0] === "string") {
        workspacePath = roots[0];
      } else {
        workspacePath = process.cwd();
      }
    }
    if (!workspacePath) return;

    const event = inputAdapterFor(ide).parse(raw, "sessionEnd");
    handleSessionEnd(workspacePath, event);
  } catch (err) {
    // Hook failures must be silent — but reported to telemetry for visibility.
    // Use blocking send: hook subprocess exits ms after this catch.
    try {
      const { sendTelemetryBlocking, classifyError } = await import("../telemetry.js");
      await sendTelemetryBlocking("error", { category: "hook", error_class: classifyError(err), fatal: false });
    } catch { /* swallow */ }
  }
}
