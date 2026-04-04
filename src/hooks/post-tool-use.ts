/**
 * PostToolUse hook - runs after Edit/Write tool calls.
 *
 * Tracks filesChanged in session metadata.
 *
 * Input: JSON on stdin from Claude Code hooks system.
 * Workspace path: passed via --workspace flag (hardcoded at setup time).
 *
 * Session ID: read from .axme-code/active-session (written by MCP server),
 * NOT from Claude Code's session_id (which is a different ID).
 */

import { trackFileChanged } from "../storage/sessions.js";
import { readActiveSession } from "../storage/sessions.js";
import { pathExists } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";

interface HookInput {
  tool_name: string;
  tool_input: Record<string, any>;
}

function handlePostToolUse(workspacePath: string, event: HookInput): void {
  const { tool_name, tool_input } = event;

  if (!["Edit", "Write", "NotebookEdit"].includes(tool_name)) return;
  if (!pathExists(join(workspacePath, AXME_CODE_DIR))) return;

  const filePath = tool_input.file_path || tool_input.path;
  if (!filePath || typeof filePath !== "string") return;
  if (filePath.includes(AXME_CODE_DIR)) return;

  const sessionId = readActiveSession(workspacePath);
  if (sessionId) {
    trackFileChanged(workspacePath, sessionId, filePath);
  }
}

/**
 * CLI entry point - reads JSON from stdin.
 * @param workspacePath - from --workspace CLI flag
 */
export async function runPostToolUseHook(workspacePath?: string): Promise<void> {
  if (!workspacePath) return; // No workspace = nothing to do

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as HookInput;
    handlePostToolUse(workspacePath, input);
  } catch {
    // Hook failures must be silent
  }
}
