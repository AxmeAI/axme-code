/**
 * PostToolUse hook - runs after Edit/Write tool calls.
 *
 * Tracks filesChanged in session metadata.
 * Called by Claude Code hooks system via: axme-code hook post-tool-use <json>
 *
 * Input (stdin or arg): JSON with { tool_name, tool_input, tool_output, session_id, project_path }
 * The hook reads the tool input to extract file paths that were modified.
 */

import { trackFileChanged } from "../storage/sessions.js";
import { logEvent } from "../storage/worklog.js";
import { pathExists } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";

export interface PostToolUseEvent {
  tool_name: string;
  tool_input: Record<string, any>;
  session_id?: string;
  project_path: string;
}

/**
 * Process a post-tool-use event.
 * Only tracks file-modifying tools: Edit, Write, NotebookEdit.
 */
export function handlePostToolUse(event: PostToolUseEvent): void {
  const { tool_name, tool_input, session_id, project_path } = event;

  // Only track file-modifying tools
  if (!["Edit", "Write", "NotebookEdit"].includes(tool_name)) return;

  // Only track if .axme-code/ exists
  if (!pathExists(join(project_path, AXME_CODE_DIR))) return;

  // Extract file path from tool input
  const filePath = tool_input.file_path || tool_input.path;
  if (!filePath || typeof filePath !== "string") return;

  // Skip .axme-code/ internal files
  if (filePath.includes(AXME_CODE_DIR)) return;

  // Track in session if we have a session ID
  if (session_id) {
    trackFileChanged(project_path, session_id, filePath);
  }
}

/**
 * CLI entry point for hook.
 * Reads event from command line argument (JSON string).
 */
export async function runPostToolUseHook(): Promise<void> {
  const arg = process.argv[3]; // axme-code hook post-tool-use <json>
  if (!arg) return;

  try {
    const event = JSON.parse(arg) as PostToolUseEvent;
    handlePostToolUse(event);
  } catch {
    // Hook failures must be silent - never break the main agent
  }
}
