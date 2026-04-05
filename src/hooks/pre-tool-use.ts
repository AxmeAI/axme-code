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

import { loadMergedSafetyRules, checkBash, checkGit, checkFilePath } from "../storage/safety.js";
import { pathExists } from "../storage/engine.js";
import { ensureAxmeSessionForClaude } from "../storage/sessions.js";
import { detectWorkspace } from "../utils/workspace-detector.js";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { AXME_CODE_DIR } from "../types.js";
import type { SafetyRules } from "../types.js";
import type { SafetyVerdict } from "../storage/safety.js";

interface HookInput {
  tool_name: string;
  tool_input: Record<string, any>;
  session_id?: string;
  transcript_path?: string;
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

/**
 * Walk up from a file path looking for the nearest git repo root.
 * Stops at the workspace boundary. Returns the workspace itself if no
 * containing repo is found (falls back to workspace-level rules).
 */
function findContainingRepo(filePath: string, workspaceRoot: string): string {
  let dir = resolve(filePath);
  // If it's a file (not a directory), start from its directory
  try {
    const stat = existsSync(dir);
    if (!stat) {
      // Path doesn't exist yet (e.g. a file about to be written) — use parent
      dir = dirname(dir);
    }
  } catch {
    dir = dirname(dir);
  }

  const rootResolved = resolve(workspaceRoot);
  while (dir.startsWith(rootResolved) && dir !== rootResolved) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return rootResolved;
}

function handlePreToolUse(sessionOrigin: string, event: HookInput): void {
  const { tool_name, tool_input } = event;

  if (!pathExists(join(sessionOrigin, AXME_CODE_DIR))) return;

  // Ensure an AXME session exists for this Claude session (lazy creation).
  // The first hook call with a given Claude session_id creates the AXME
  // session and writes the mapping file. Subsequent calls for the same
  // Claude session reuse the mapping. This is how multi-window isolation
  // works: each VS Code window has its own Claude session_id → its own
  // AXME session → no last-writer-wins on a shared pointer file.
  //
  // We do this in PreToolUse (not only PostToolUse) so the AXME session
  // exists before any safety denial — we want the audit trail even for
  // blocked tool calls.
  if (event.session_id && event.transcript_path) {
    ensureAxmeSessionForClaude(sessionOrigin, event.session_id, event.transcript_path);
  }

  // Determine if the session origin is a workspace (multi-repo) or a single repo.
  // For multi-repo workspaces, safety rules are merged from workspace-level +
  // the specific repo being touched. For single repos, only one level exists.
  const workspaceInfo = detectWorkspace(sessionOrigin);
  const isWorkspace = workspaceInfo.type !== "single";
  const workspaceRoot = isWorkspace ? sessionOrigin : undefined;

  // Resolve the target repo for file-based tool calls. For Bash we use the
  // workspace-level rules (commands are not tied to a specific repo).
  function loadRulesForFile(filePath: string): SafetyRules {
    if (!isWorkspace) return loadMergedSafetyRules(sessionOrigin);
    const repo = findContainingRepo(filePath, workspaceRoot!);
    return loadMergedSafetyRules(repo, workspaceRoot);
  }

  function loadRulesForBash(): SafetyRules {
    return loadMergedSafetyRules(sessionOrigin, workspaceRoot);
  }

  let verdict: SafetyVerdict = { allowed: true };

  switch (tool_name) {
    case "Bash": {
      const command = (tool_input.command as string) ?? "";
      const rules = loadRulesForBash();
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
        const rules = loadRulesForFile(filePath);
        verdict = checkFilePath(rules, filePath, "read");
      }
      break;
    }
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const filePath = (tool_input.file_path || tool_input.path) as string;
      if (filePath) {
        const rules = loadRulesForFile(filePath);
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
