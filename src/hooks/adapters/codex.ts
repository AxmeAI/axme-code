/**
 * Codex CLI hook adapter.
 *
 * Stdin shape (per learn.chatgpt.com/docs/hooks, checked against codex-cli
 * 0.166, 2026-11): the common base carries session_id, transcript_path
 * (string | null), cwd, hook_event_name, model, permission_mode, turn_id.
 * PreToolUse / PostToolUse add tool_name, tool_input, tool_use_id (and
 * tool_response on Post). SessionEnd adds reason (always "other").
 *
 * The protocol is deliberately Claude-Code-compatible: PascalCase event
 * names, the same hooks.json shape, and the same deny envelope
 * (`hookSpecificOutput.permissionDecision`, exit 0). The output adapter is
 * therefore the Claude Code one, re-exported under a Codex name.
 *
 * What differs for the IDE-agnostic hook cores:
 *   - Shell commands arrive as tool_name "Bash" with tool_input.command,
 *     exactly like Claude Code.
 *   - File edits arrive as tool_name "apply_patch" with the whole patch in
 *     tool_input.command (Codex has no Edit / Write / Read tools). We
 *     normalize the name to "Edit" and collect every touched path from the
 *     patch header lines (`*** Add File:`, `*** Update File:`,
 *     `*** Delete File:`, `*** Move to:`) into `filePaths`, resolved
 *     against the payload's cwd when relative.
 *   - MCP tool calls arrive as "mcp__<server>__<tool>" and carry no shell
 *     or file payload, so they fall through the safety switch untouched.
 */

import { isAbsolute, resolve } from "node:path";
import { claudeCodeOutputAdapter } from "./claude-code.js";
import type { HookInputAdapter, HookOutputAdapter, NormalizedHookEvent } from "./types.js";

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}

const PATCH_HEADER = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/;

/**
 * Extract every path named in an apply_patch envelope, in order of first
 * appearance, deduplicated. Relative paths are resolved against `cwd`
 * when it is known; otherwise they are returned as written.
 */
export function extractPatchPaths(patch: string, cwd?: string): string[] {
  const out: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = PATCH_HEADER.exec(line);
    if (!m) continue;
    const raw = m[1].trim();
    if (!raw) continue;
    const abs = isAbsolute(raw) || !cwd ? raw : resolve(cwd, raw);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

export const codexInputAdapter: HookInputAdapter = {
  parse(raw, kind): NormalizedHookEvent {
    const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const rawToolName = asString(obj.tool_name);
    const toolInput = asObject(obj.tool_input);
    const cwd = asString(obj.cwd);
    const sessionId = asString(obj.session_id);

    // transcript_path is documented as string | null. Preserve null so
    // callers can tell "no transcript yet" from "field absent".
    let transcriptPath: string | null | undefined;
    if (obj.transcript_path === null) transcriptPath = null;
    else transcriptPath = asString(obj.transcript_path);

    const reason = kind === "sessionEnd" ? asString(obj.reason) : undefined;

    let toolName = rawToolName;
    let filePaths: string[] | undefined;
    if (rawToolName === "apply_patch") {
      toolName = "Edit";
      // The docs name `command`; the underlying custom tool call uses
      // `input`. Accept both so a payload-shape drift degrades to "no
      // paths found" rather than a parse failure.
      const patch = asString(toolInput?.command) ?? asString(toolInput?.input) ?? "";
      filePaths = extractPatchPaths(patch, cwd);
    }

    return {
      kind,
      ide: "codex",
      toolName,
      toolInput,
      filePaths,
      sessionId,
      transcriptPath,
      reason,
      raw: obj,
    };
  },
};

/** Codex accepts the Claude Code deny envelope verbatim (exit 0 + JSON). */
export const codexOutputAdapter: HookOutputAdapter = claudeCodeOutputAdapter;
