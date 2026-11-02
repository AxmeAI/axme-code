/**
 * Idempotent writers for Codex-specific config files.
 *
 * Layout (all project-level):
 *   .codex/config.toml   — [mcp_servers.axme] registration (Codex config is TOML)
 *   .codex/hooks.json    — SessionStart / PreToolUse / PostToolUse / SessionEnd
 *   AGENTS.md            — the "## AXME Code" section (Codex's CLAUDE.md analogue)
 *
 * Codex loads a project's .codex/ layer (config, hooks, rules) only once the
 * project is trusted (`projects."<path>".trust_level = "trusted"` in
 * ~/.codex/config.toml). Codex offers to set that the first time it opens
 * the repo; setup prints a reminder.
 *
 * Two more Codex gates, both verified live on codex-cli 0.166 (2026-11-02):
 *   - Hook trust. Non-managed hooks run only after the user reviews and
 *     trusts them via `/hooks` in an interactive session. Trust is recorded
 *     against the hook definition's hash, so any change to the command
 *     (e.g. the binary path after a release) needs a re-trust. Untrusted
 *     hooks are skipped silently — `codex exec` has
 *     `--dangerously-bypass-hook-trust` for automation.
 *   - MCP tool approval. Without `default_tools_approval_mode = "approve"`
 *     on the server table, every axme_* call prompts in the TUI and fails
 *     outright under `codex exec` ("requires approval, but approval policy
 *     is never"). "auto" is NOT enough — verified live, it still prompted.
 *     The writer sets "approve": AXME tools only touch .axme-code/.
 *
 * Codex's hooks.json is the Claude Code settings.json `hooks` shape
 * verbatim (PascalCase events, `{ matcher?, hooks: [{ type, command,
 * timeout }] }` groups), so the writer mirrors configureHooks() in cli.ts
 * rather than the camelCase Cursor one. Every command gets `--ide codex`
 * appended so the hook subprocess picks the right adapter without
 * re-detecting.
 *
 * Idempotency rule shared with the other writers: entries that mention
 * "axme-code" are ours and get replaced; everything else is preserved
 * verbatim. A file that exists but cannot be parsed is left untouched
 * (refuse-don't-clobber).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type CodexHookEvent = "SessionStart" | "PreToolUse" | "PostToolUse" | "SessionEnd";

/** Timeouts in seconds (Codex semantics). SessionEnd is capped at 3 by Codex. */
const HOOK_TIMEOUT_S: Record<CodexHookEvent, number> = {
  SessionStart: 10,
  PreToolUse: 5,
  PostToolUse: 10,
  SessionEnd: 3,
};

const CLI_HOOK_NAME: Record<CodexHookEvent, string> = {
  SessionStart: "session-start",
  PreToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  SessionEnd: "session-end",
};

/**
 * PostToolUse fires for file edits only. Codex reports edits as
 * `apply_patch`; its matcher also accepts the Claude Code aliases, listed
 * for readers who grep for them.
 */
const POST_TOOL_USE_MATCHER = "apply_patch|Edit|Write";

interface CodexHookCommand {
  type?: "command";
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookCommand[];
  [key: string]: unknown;
}

interface CodexHooksFile {
  hooks?: Partial<Record<string, CodexHookGroup[]>>;
  [key: string]: unknown;
}

export interface ServeCommand {
  command: string;
  args: string[];
}

/**
 * Read a JSON file, returning `fallback` when it doesn't exist (or is
 * empty) and `null` when it exists but cannot be parsed. Callers MUST
 * treat `null` as "refuse to write".
 */
function readJsonOr<T extends object>(path: string, fallback: T): T | null {
  if (!existsSync(path)) return fallback;
  try {
    const raw = readFileSync(path, "utf-8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/**
 * Write `.codex/hooks.json` with four PascalCase event arrays. Existing
 * groups that mention "axme-code" anywhere are dropped before re-insert;
 * user-added groups are preserved verbatim.
 */
export function writeCodexHooksJson(
  projectPath: string,
  buildHookCommand: (hookName: string, projectPath: string) => string,
): void {
  const path = join(projectPath, ".codex", "hooks.json");
  const cfg = readJsonOr<CodexHooksFile>(path, {});
  if (cfg === null) {
    console.error(`  ${path}: SKIPPED — existing file is not valid JSON. Fix or remove it, then re-run setup; refusing to overwrite user config.`);
    return;
  }
  if (!cfg.hooks) cfg.hooks = {};

  const events: CodexHookEvent[] = ["SessionStart", "PreToolUse", "PostToolUse", "SessionEnd"];
  for (const event of events) {
    const existing = cfg.hooks[event] ?? [];
    const preserved = existing.filter((g) => !JSON.stringify(g).includes("axme-code"));
    const fresh: CodexHookGroup = {
      hooks: [{
        type: "command",
        command: `${buildHookCommand(CLI_HOOK_NAME[event], projectPath)} --ide codex`,
        timeout: HOOK_TIMEOUT_S[event],
      }],
    };
    if (event === "PostToolUse") fresh.matcher = POST_TOOL_USE_MATCHER;
    cfg.hooks[event] = [...preserved, fresh];
  }

  writeText(path, JSON.stringify(cfg, null, 2) + "\n");
}

/** TOML basic strings share JSON's escape rules for everything a path can contain. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

function mcpServerTable(serve: ServeCommand): string {
  return [
    "[mcp_servers.axme]",
    `command = ${tomlString(serve.command)}`,
    `args = [${serve.args.map(tomlString).join(", ")}]`,
    "# AXME tools only read/write this project's .axme-code/ knowledge base:",
    "# run them without a per-call approval prompt (required under `codex exec`).",
    'default_tools_approval_mode = "approve"',
    "",
  ].join("\n");
}

const AXME_TABLE_HEADER = /^\[mcp_servers\.axme\]\s*$/;
const ANY_TABLE_HEADER = /^\s*\[/;

/**
 * Write `[mcp_servers.axme]` into `.codex/config.toml`, replacing a
 * previous axme table in place and leaving every other line (other
 * servers, comments, unrelated keys) byte-for-byte untouched. We edit the
 * text rather than parse-and-dump so user comments survive.
 */
export function writeCodexConfigToml(projectPath: string, serve: ServeCommand): void {
  const path = join(projectPath, ".codex", "config.toml");
  const table = mcpServerTable(serve);
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";

  if (!existing.trim()) {
    writeText(path, table);
    return;
  }

  const lines = existing.split("\n");
  const start = lines.findIndex((l) => AXME_TABLE_HEADER.test(l));
  if (start === -1) {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    writeText(path, existing + sep + table);
    return;
  }
  // The table body runs until the next table header (any `[...]` line) or EOF.
  let end = start + 1;
  while (end < lines.length && !ANY_TABLE_HEADER.test(lines[end])) end++;
  // Keep one blank line between our table and whatever follows.
  const tail = lines.slice(end);
  const replaced = [...lines.slice(0, start), ...table.trimEnd().split("\n"), ...(tail.length ? ["", ...tail] : [""])];
  writeText(path, replaced.join("\n"));
}

const CODEX_SECTION_SUFFIX = `
### Git commit/push gate
Every \`git commit\` and \`git push\` command MUST end with the marker:
\`\`\`
#!axme pr=<NUMBER|none> repo=<OWNER/REPO>
\`\`\`
Without this suffix the PreToolUse hook blocks the command. Use pr=none when no PR exists yet.
`;

/**
 * The AGENTS.md section: the CLAUDE.md template (passed in by the CLI so
 * the two stay in lockstep) plus the git gate, which Claude Code learns
 * from the MCP server instructions but Codex does not surface.
 */
export function buildAgentsMdSection(baseSection: string): string {
  return baseSection.trimEnd() + "\n" + CODEX_SECTION_SUFFIX;
}

/**
 * Insert or refresh the "## AXME Code" section in AGENTS.md. Unlike the
 * CLAUDE.md writer this replaces ONLY our section — everything after the
 * next top-level `## ` heading is kept — because AGENTS.md is the user's
 * file and routinely has content after ours.
 *
 * Returns what happened, for the setup log line.
 */
export function writeAgentsMdSection(projectPath: string, section: string): "created" | "appended" | "updated" {
  const path = join(projectPath, "AGENTS.md");
  const marker = "## AXME Code";
  const body = section.endsWith("\n") ? section : section + "\n";

  if (!existsSync(path)) {
    writeText(path, body);
    return "created";
  }
  const content = readFileSync(path, "utf-8");
  const start = content.indexOf(marker);
  if (start === -1) {
    writeText(path, content.trimEnd() + "\n\n" + body);
    return "appended";
  }
  const nextHeading = content.indexOf("\n## ", start + marker.length);
  const after = nextHeading === -1 ? "" : content.slice(nextHeading + 1);
  const before = content.slice(0, start);
  writeText(path, before + body + (after ? "\n" + after : ""));
  return "updated";
}
