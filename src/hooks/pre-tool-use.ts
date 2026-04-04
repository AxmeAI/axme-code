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

/**
 * Split a shell command into executable segments by &&, ||, ;, and |.
 * Respects quoted strings so "git reset" inside quotes is not a segment.
 */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }
    if (ch === "\\" && i + 1 < command.length) { current += ch + command[i + 1]; i += 2; continue; }
    if (!inSingle && !inDouble) {
      if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
        segments.push(current);
        current = "";
        i += 2;
        continue;
      }
      if (ch === "|" || ch === ";" ) {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
    }
    current += ch;
    i++;
  }
  if (current.trim()) segments.push(current);
  return segments;
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
      // Only apply git checks to command segments that actually invoke git,
      // not to text arguments that happen to contain "git" (e.g. PR body text).
      for (const seg of splitCommandSegments(command)) {
        const trimSeg = seg.trim();
        if (/^\s*git\b/.test(trimSeg)) {
          verdict = checkGit(rules, trimSeg);
          if (!verdict.allowed) break;
        }
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
