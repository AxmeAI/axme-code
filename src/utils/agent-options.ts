/**
 * Shared agent query options builder for LLM scanner agents.
 */

import { execSync } from "node:child_process";

type Options = import("@anthropic-ai/claude-agent-sdk").Options;

/** Find claude binary path. Cached after first lookup. */
let _claudePath: string | undefined;
function findClaudePath(): string | undefined {
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
  };
}
