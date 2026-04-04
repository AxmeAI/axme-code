/**
 * PostToolUse hook - runs after Edit/Write tool calls.
 *
 * Tracks filesChanged in session metadata.
 * Input: JSON on stdin from Claude Code hooks system.
 * Format: { session_id, cwd, hook_event_name, tool_name, tool_input: { file_path } }
 */

import { trackFileChanged } from "../storage/sessions.js";
import { pathExists } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, any>;
}

function handlePostToolUse(event: HookInput): void {
  const { tool_name, tool_input, session_id, cwd } = event;

  if (!["Edit", "Write", "NotebookEdit"].includes(tool_name)) return;
  if (!pathExists(join(cwd, AXME_CODE_DIR))) return;

  const filePath = tool_input.file_path || tool_input.path;
  if (!filePath || typeof filePath !== "string") return;
  if (filePath.includes(AXME_CODE_DIR)) return;

  if (session_id) {
    trackFileChanged(cwd, session_id, filePath);
  }
}

/**
 * CLI entry point - reads JSON from stdin.
 */
export async function runPostToolUseHook(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as HookInput;
    handlePostToolUse(input);
  } catch {
    // Hook failures must be silent
  }
}
