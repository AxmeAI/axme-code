/**
 * Claude Code hook adapter.
 *
 * Stdin shape (per Anthropic's hooks API):
 *   { tool_name, tool_input, session_id?, transcript_path? }
 *
 * Deny is signalled by writing a JSON object to stdout and exiting 0. Exit
 * codes are not used to convey allow/deny; only the JSON payload matters:
 *
 *   { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
 */

import type { HookInputAdapter, HookKind, HookOutputAdapter, NormalizedHookEvent, DenyResult } from "./types.js";

function pascalCaseFor(kind: HookKind): string {
  switch (kind) {
    case "preToolUse": return "PreToolUse";
    case "postToolUse": return "PostToolUse";
    case "sessionEnd": return "SessionEnd";
  }
}

export const claudeCodeInputAdapter: HookInputAdapter = {
  parse(raw, kind): NormalizedHookEvent {
    const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const toolName = typeof obj.tool_name === "string" ? obj.tool_name : undefined;
    const toolInput = (obj.tool_input && typeof obj.tool_input === "object")
      ? obj.tool_input as Record<string, unknown>
      : undefined;
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
    const transcriptPath = typeof obj.transcript_path === "string" ? obj.transcript_path : undefined;
    return {
      kind,
      ide: "claude-code",
      toolName,
      toolInput,
      sessionId,
      transcriptPath,
      raw: obj,
    };
  },
};

export const claudeCodeOutputAdapter: HookOutputAdapter = {
  emitDeny(reason, kind): DenyResult {
    const output = {
      hookSpecificOutput: {
        hookEventName: pascalCaseFor(kind),
        permissionDecision: "deny",
        permissionDecisionReason: `[AXME Safety] ${reason}`,
      },
    };
    return { stdout: JSON.stringify(output), exitCode: 0 };
  },
};
