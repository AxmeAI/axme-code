/**
 * PostToolUse hook — runs after Edit/Write tool calls.
 *
 * Tracks filesChanged in session metadata, and attaches the IDE's session
 * (id + transcript_path from the hook event) to the current AXME session
 * so the LLM auditor can later read the full transcript.
 *
 * Input: JSON on stdin from the IDE's hooks system. Stdin shape varies by
 * IDE (Claude Code vs Cursor); the adapter in src/hooks/adapters/ handles
 * the per-IDE field renames before the handler core runs.
 *
 * Session ID: read from `.axme-code/active-sessions/<ide-session-id>.txt`
 * (written by MCP server / earlier hooks), NOT from the IDE's session id
 * directly (which is a different ID space).
 */

import { trackFileChanged, ensureAxmeSessionForClaude } from "../storage/sessions.js";
import { pathExists } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";
import type { IdeKind } from "../types.js";
import { claudeCodeInputAdapter } from "./adapters/claude-code.js";
import { cursorInputAdapter } from "./adapters/cursor.js";
import type { HookInputAdapter, NormalizedHookEvent } from "./adapters/types.js";

function inputAdapterFor(ide: IdeKind): HookInputAdapter {
  return ide === "cursor" ? cursorInputAdapter : claudeCodeInputAdapter;
}

function handlePostToolUse(workspacePath: string, event: NormalizedHookEvent): void {
  const tool_name = event.toolName ?? "";
  const tool_input = (event.toolInput ?? {}) as Record<string, any>;

  if (!pathExists(join(workspacePath, AXME_CODE_DIR))) return;

  // Ensure the AXME session exists for this Claude session_id (lazy creation).
  // Without session_id we cannot route this hook call — silently skip.
  if (!event.sessionId || !event.transcriptPath) return;

  const axmeSessionId = ensureAxmeSessionForClaude(
    workspacePath,
    event.sessionId,
    event.transcriptPath,
    undefined,
    event.ide,
  );

  // filesChanged tracking only for mutation tools
  if (!["Edit", "Write", "NotebookEdit"].includes(tool_name)) return;

  const filePath = tool_input.file_path || tool_input.path;
  if (!filePath || typeof filePath !== "string") return;
  if (filePath.includes(AXME_CODE_DIR)) return;

  trackFileChanged(workspacePath, axmeSessionId, filePath);
}

/**
 * CLI entry point - reads JSON from stdin.
 * @param workspacePath - from --workspace CLI flag
 * @param ide - from --ide CLI flag (defaults to "claude-code")
 */
export async function runPostToolUseHook(workspacePath?: string, ide: IdeKind = "claude-code"): Promise<void> {
  // Skip entirely when we are running inside a subclaude audit worker
  // (see session-auditor env: { ...process.env, AXME_SKIP_HOOKS: "1" }).
  // Without this early exit, every tool call the auditor makes would spawn
  // a ghost AXME session via ensureAxmeSessionForClaude (Bug F from PR#6).
  if (process.env.AXME_SKIP_HOOKS === "1") return;

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

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

    const event = inputAdapterFor(ide).parse(raw, "postToolUse");
    handlePostToolUse(workspacePath, event);
  } catch (err) {
    // Hook failures must be silent — but reported to telemetry for visibility.
    // Use blocking send: hook subprocess exits ms after this catch and would
    // kill any setImmediate-queued network call.
    try {
      const { sendTelemetryBlocking, classifyError } = await import("../telemetry.js");
      await sendTelemetryBlocking("error", { category: "hook", error_class: classifyError(err), fatal: false });
    } catch { /* swallow */ }
  }
}
