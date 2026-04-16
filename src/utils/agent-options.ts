/**
 * Shared agent query options builder for LLM scanner agents.
 */

import { execSync } from "node:child_process";
import { resolveAuthMode } from "./auth-config.js";

type Options = import("@anthropic-ai/claude-agent-sdk").Options;

/**
 * Find claude binary path. Cached after first lookup.
 *
 * Exported because the SDK resolves its own path via `import.meta.url`, which
 * returns undefined inside the bundled CJS build and crashes with
 * `fileURLToPath(undefined)` (B-006 / D-121). Every direct `sdk.query()` call
 * site must set `pathToClaudeCodeExecutable` to the result of this function.
 */
let _claudePath: string | undefined;
export function findClaudePath(): string | undefined {
  if (_claudePath !== undefined) return _claudePath || undefined;
  try {
    _claudePath = execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    _claudePath = "";
  }
  return _claudePath || undefined;
}

export type AgentRole = "scanner" | "tester" | "reviewer" | "engineer" | "architect" | "auditor";

const ROLE_TOOLS: Record<AgentRole, { allowed: string[]; disallowed: string[] }> = {
  auditor: {
    allowed: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "Agent"],
    disallowed: ["WebFetch", "WebSearch", "TodoWrite", "Skill", "NotebookEdit", "ToolSearch"],
  },
  scanner: {
    allowed: ["Read", "Glob", "Grep", "Bash"],
    disallowed: ["Write", "Edit", "Agent", "NotebookEdit", "Skill", "TodoWrite"],
  },
  tester: {
    allowed: ["Read", "Glob", "Grep", "Bash"],
    disallowed: ["Edit", "Write", "Agent", "TodoWrite", "NotebookEdit", "Skill"],
  },
  reviewer: {
    allowed: ["Read", "Glob", "Grep", "Bash"],
    disallowed: ["Edit", "Write", "Agent", "TodoWrite", "NotebookEdit", "Skill"],
  },
  engineer: {
    allowed: ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "Agent", "TodoWrite", "NotebookEdit"],
    disallowed: ["Skill"],
  },
  architect: {
    allowed: ["Read", "Glob", "Grep"],
    disallowed: ["Write", "Edit", "Bash", "Agent", "NotebookEdit", "Skill", "TodoWrite"],
  },
};

/**
 * Build the env passed to every Claude Code subprocess we spawn for LLM work.
 *
 * Two things happen here:
 *   1. `AXME_TELEMETRY_DISABLED` and `AXME_SKIP_HOOKS` are set to suppress
 *      recursive startup events and ghost AXME sessions when the sub-claude
 *      inadvertently launches axme-code as its own MCP server.
 *   2. If the user has selected `subscription` as the auth mode (either via
 *      `axme-code auth` / `axme-code setup`, or by heuristic when only the
 *      subscription is detected), we delete `ANTHROPIC_API_KEY` before
 *      handing env to the subprocess. Claude Code checks the env var before
 *      its OAuth credentials, so leaving an empty-balance key in env would
 *      surface as "Credit balance is too low" or 401 auth errors even when
 *      the user has an active subscription. Delete, not empty string: Claude
 *      Code treats an empty-string value as "set" and still prefers it over
 *      OAuth.
 */
export function buildAgentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AXME_TELEMETRY_DISABLED: "1",
    AXME_SKIP_HOOKS: "1",
  };
  if (resolveAuthMode() === "subscription") {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

export function buildAgentQueryOptions(base: {
  cwd: string;
  model: string;
  maxTurns?: number;
  agentPrompt?: string;
}, role: AgentRole): Options {
  const tools = ROLE_TOOLS[role];

  const claudePath = findClaudePath();

  return {
    cwd: base.cwd,
    model: base.model,
    systemPrompt: base.agentPrompt
      ? { type: "preset" as const, preset: "claude_code" as const, append: base.agentPrompt }
      : { type: "preset" as const, preset: "claude_code" as const },
    settingSources: ["project"],
    ...(base.maxTurns !== undefined ? { maxTurns: base.maxTurns } : {}),
    ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: tools.allowed,
    disallowedTools: tools.disallowed,
    includePartialMessages: true,
    env: buildAgentEnv(),
  };
}
