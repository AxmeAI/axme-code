/**
 * PreToolUse hook - HARD safety enforcement.
 *
 * Intercepts tool calls BEFORE execution and blocks violations.
 * Uses the same checkBash/checkGit/checkFilePath from storage/safety.ts.
 *
 * Output format (to block):
 *   { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "..." } }
 *
 * Silent exit (no output) = allow.
 */

import { loadSafetyRules, checkBash, checkGit, checkFilePath } from "../storage/safety.js";
import { pathExists } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";
import type { SafetyVerdict } from "../storage/safety.js";

interface HookInput {
  tool_name: string;
  tool_input: Record<string, any>;
}

function deny(reason: string): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[AXME Safety] ${reason}`,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

function handlePreToolUse(workspacePath: string, event: HookInput): void {
  const { tool_name, tool_input } = event;

  if (!pathExists(join(workspacePath, AXME_CODE_DIR))) return;

  const rules = loadSafetyRules(workspacePath);
  let verdict: SafetyVerdict = { allowed: true };

  switch (tool_name) {
    case "Bash": {
      const command = (tool_input.command as string) ?? "";
      verdict = checkBash(rules, command);
      if (!verdict.allowed) break;
      if (/\bgit\b/.test(command)) {
        verdict = checkGit(rules, command);
      }
      break;
    }
    case "Read":
    case "Glob":
    case "Grep": {
      const filePath = (tool_input.file_path || tool_input.path) as string;
      if (filePath) {
        verdict = checkFilePath(rules, filePath, "read");
      }
      break;
    }
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const filePath = (tool_input.file_path || tool_input.path) as string;
      if (filePath) {
        verdict = checkFilePath(rules, filePath, "write");
      }
      break;
    }
  }

  if (!verdict.allowed) {
    deny(verdict.reason);
  }
}

/**
 * CLI entry point - reads JSON from stdin.
 * @param workspacePath - from --workspace CLI flag
 */
export async function runPreToolUseHook(workspacePath?: string): Promise<void> {
  if (!workspacePath) return;

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as HookInput;
    handlePreToolUse(workspacePath, input);
  } catch {
    // Hook failures must be silent - fail open for safety
  }
}
