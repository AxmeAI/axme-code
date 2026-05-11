/**
 * Cursor hook adapter.
 *
 * Stdin shape (verified against cursor.com/docs/agent/hooks, 2026-05):
 *   common base fields:
 *     conversation_id, generation_id, model, hook_event_name,
 *     cursor_version, workspace_roots[], user_email?, transcript_path|null
 *   preToolUse / postToolUse add:
 *     tool_name, tool_input, tool_use_id, cwd, agent_message
 *   sessionEnd adds:
 *     session_id, reason ("completed"|"aborted"|"error"|"window_close"|...),
 *     duration_ms, is_background_agent, final_status, error_message?
 *
 * Deny on preToolUse / beforeShellExecution / beforeMCPExecution:
 *   stdout JSON: { permission: "allow"|"deny"|"ask", user_message, agent_message, updated_input? }
 *   exit code 0 = success, 2 = deny, other = fail-open
 */

import type { HookInputAdapter, HookKind, HookOutputAdapter, NormalizedHookEvent, DenyResult } from "./types.js";

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}

/**
 * Normalize Cursor's tool names to Claude Code's vocabulary so the
 * IDE-agnostic safety/file-tracking core (which switches on `Bash`,
 * `Edit`, `Read`, etc.) treats them uniformly. Cursor renames Bash →
 * Shell; the rest of the taxonomy overlaps. Surfaced empirically:
 * `tool_name: "Shell"` payload from Cursor preToolUse fell through
 * pre-tool-use.ts's switch, allowing `git push --force` past the deny
 * rule (2026-05-11 E2E test, check 6).
 */
function normalizeCursorToolName(name: string | undefined): string | undefined {
  if (!name) return name;
  if (name === "Shell") return "Bash";
  return name;
}

export const cursorInputAdapter: HookInputAdapter = {
  parse(raw, kind): NormalizedHookEvent {
    const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const toolName = normalizeCursorToolName(asString(obj.tool_name));
    const toolInput = asObject(obj.tool_input);

    // Use conversation_id as the stable AXME session key across ALL three
    // hook events. conversation_id is part of Cursor's common-base fields
    // (present in preToolUse, postToolUse, AND sessionEnd payloads), and
    // it represents one chat thread — exactly the granularity AXME wants
    // for one filesChanged trail / one audit. session_id is only event-
    // specific to sessionStart/sessionEnd and may identify a coarser SDK
    // session that spans multiple conversations; using it would break the
    // mapping created by pre/postToolUse (which only sees conversation_id),
    // leaving the work as an orphan at audit time. Fall back to session_id
    // only if conversation_id is somehow missing.
    const sessionId = asString(obj.conversation_id) ?? asString(obj.session_id);

    // transcript_path may legitimately be null on Cursor (e.g. very first
    // turn). Preserve null so callers can distinguish "no transcript yet"
    // from "field absent".
    let transcriptPath: string | null | undefined;
    if (obj.transcript_path === null) transcriptPath = null;
    else transcriptPath = asString(obj.transcript_path);

    const reason = kind === "sessionEnd" ? asString(obj.reason) : undefined;

    return {
      kind,
      ide: "cursor",
      toolName,
      toolInput,
      sessionId,
      transcriptPath,
      reason,
      raw: obj,
    };
  },
};

export const cursorOutputAdapter: HookOutputAdapter = {
  emitDeny(reason, _kind): DenyResult {
    const message = `[AXME Safety] ${reason}`;
    const output = {
      permission: "deny",
      user_message: message,
      agent_message: message,
    };
    // Exit code 2 is Cursor's documented "deny" signal; the JSON body is
    // also required so Cursor's UI shows the reason. Both must agree.
    return { stdout: JSON.stringify(output), exitCode: 2 };
  },
};
