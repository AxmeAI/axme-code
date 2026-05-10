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

export const cursorInputAdapter: HookInputAdapter = {
  parse(raw, kind): NormalizedHookEvent {
    const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const toolName = asString(obj.tool_name);
    const toolInput = asObject(obj.tool_input);

    // Pre/postToolUse: Cursor identifies the running session via
    // conversation_id (per-conversation) + generation_id (per-turn).
    // Use conversation_id as the stable session id so consecutive tool calls
    // in the same conversation route to the same AXME session.
    // sessionEnd: Cursor sends a top-level session_id that may differ from
    // conversation_id (it identifies the SDK session, not the chat).
    let sessionId: string | undefined;
    if (kind === "sessionEnd") {
      sessionId = asString(obj.session_id) ?? asString(obj.conversation_id);
    } else {
      sessionId = asString(obj.conversation_id) ?? asString(obj.session_id);
    }

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
