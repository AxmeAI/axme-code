/**
 * Idempotent writers for Cursor-specific config files.
 *
 * Layout:
 *   .cursor/mcp.json            — Cursor's MCP server registration (mirrors .mcp.json)
 *   .cursor/hooks.json          — preToolUse / postToolUse / sessionEnd commands
 *   .cursor/rules/axme-code.mdc — auto-applied rule (Cursor's CLAUDE.md analogue)
 *
 * All three writers preserve user-added entries on re-run: the merge logic
 * filters out previous axme entries by string match on `axme-code` in the
 * command field, then re-adds fresh ones — exactly the pattern
 * configureHooks() uses for `.claude/settings.json`.
 *
 * D-080 forbids writing `.claude/CLAUDE.md`. Cursor's analogue is
 * `.cursor/rules/<rule>.mdc` with YAML frontmatter (`alwaysApply: true`).
 * The body content mirrors the Claude Code template but is reworded for
 * Cursor terminology ("Cursor session" not "Claude session").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HOOK_TIMEOUT_MS: Record<HookKind, number> = {
  preToolUse: 5,
  postToolUse: 10,
  sessionEnd: 120,
};

type HookKind = "preToolUse" | "postToolUse" | "sessionEnd";

interface CursorHookEntry {
  command: string;
  type?: "command";
  timeout?: number;
  matcher?: string;
  failClosed?: boolean;
  loop_limit?: number | null;
  [key: string]: unknown;
}

interface CursorHooksFile {
  version?: number;
  hooks?: Partial<Record<HookKind, CursorHookEntry[]>>;
  [key: string]: unknown;
}

interface CursorMcpFile {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  [key: string]: unknown;
}

function readJsonOr<T extends object>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

/**
 * Write `.cursor/mcp.json`, merging with any existing servers. Cursor reads
 * `.cursor/mcp.json` AND root `.mcp.json` — we always write the Cursor
 * one too, so a repo configured with `--ide=cursor` keeps working even
 * if the user later removes `.mcp.json`.
 */
export function writeCursorMcpJson(projectPath: string): void {
  const path = join(projectPath, ".cursor", "mcp.json");
  const cfg = readJsonOr<CursorMcpFile>(path, {});
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers.axme = { command: "axme-code", args: ["serve"] };
  writeJsonAtomic(path, cfg);
}

/**
 * Write `.cursor/hooks.json` with three event arrays. Each entry uses
 * `buildHookCommand()` with `--ide cursor` appended so the hook
 * subprocess can pick the right adapter without re-detecting.
 *
 * Idempotency: existing entries whose command contains "axme-code" are
 * dropped before re-insert; user-added entries are preserved verbatim.
 */
export function writeCursorHooksJson(
  projectPath: string,
  buildHookCommand: (hookName: string, projectPath: string) => string,
): void {
  const path = join(projectPath, ".cursor", "hooks.json");
  const cfg = readJsonOr<CursorHooksFile>(path, { version: 1 });
  if (!cfg.version) cfg.version = 1;
  if (!cfg.hooks) cfg.hooks = {};

  const hookKinds: HookKind[] = ["preToolUse", "postToolUse", "sessionEnd"];
  const cliHookNames: Record<HookKind, string> = {
    preToolUse: "pre-tool-use",
    postToolUse: "post-tool-use",
    sessionEnd: "session-end",
  };

  for (const kind of hookKinds) {
    const existing = cfg.hooks[kind] ?? [];
    const preserved = existing.filter((e) => !String(e.command ?? "").includes("axme-code"));
    const fresh: CursorHookEntry = {
      command: `${buildHookCommand(cliHookNames[kind], projectPath)} --ide cursor`,
      type: "command",
      timeout: HOOK_TIMEOUT_MS[kind],
    };
    cfg.hooks[kind] = [...preserved, fresh];
  }

  writeJsonAtomic(path, cfg);
}

const RULE_FRONTMATTER = `---
name: axme-code
description: AXME Code session start ritual + safety reminders for Cursor
alwaysApply: true
---
`;

const RULE_BODY = `## AXME Code

### Session Start (MANDATORY)
Call \`axme_context\` tool with this project's path at the start of every Cursor session.
This loads: oracle, decisions, safety rules, memories, test plan, active plans.
Do NOT skip — without context you will miss critical project rules.

### NEVER run \`axme-code setup\` yourself
Setup is the user's job. The Cursor extension offers a "Run setup?" toast on
first activation; the user can also run \`AXME: Setup\` from the Command
Palette. **Do not invoke \`axme-code setup\` via Bash autonomously**, even if
\`axme_context\` returns "not initialized" — just relay the message to the
user and wait.

### During Work
- Error pattern or successful approach discovered → call \`axme_save_memory\` immediately.
- Architectural decision made or discovered → call \`axme_save_decision\` immediately.
- New safety constraint found → call \`axme_update_safety\` immediately.

### Git commit/push gate
Every \`git commit\` and \`git push\` command MUST end with the marker:
\`\`\`
#!axme pr=<NUMBER|none> repo=<OWNER/REPO>
\`\`\`
Without this suffix the pre-tool-use hook blocks the command.

### Available AXME tools
\`axme_context\`, \`axme_save_memory\`, \`axme_save_decision\`, \`axme_update_safety\`,
\`axme_safety\`, \`axme_status\`, \`axme_worklog\`, \`axme_workspace\`,
\`axme_oracle\`, \`axme_decisions\`, \`axme_memories\`.
`;

/**
 * Write `.cursor/rules/axme-code.mdc` (Cursor's auto-applied rule format).
 * Always overwrites — the rule body is canonical and small. Frontmatter
 * `alwaysApply: true` makes Cursor inject this content into every chat
 * session's system context.
 */
export function writeCursorRulesMdc(projectPath: string, _isWorkspace: boolean): void {
  const path = join(projectPath, ".cursor", "rules", "axme-code.mdc");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, RULE_FRONTMATTER + "\n" + RULE_BODY, "utf-8");
}
