/**
 * Shared agent query options builder for LLM scanner agents.
 */

type Options = import("@anthropic-ai/claude-agent-sdk").Options;

export type AgentRole = "scanner" | "tester" | "reviewer" | "engineer" | "architect" | "auditor";

const ROLE_TOOLS: Record<AgentRole, { allowed: string[]; disallowed: string[] }> = {
  auditor: {
    allowed: ["Read", "Glob", "Grep", "Edit", "Write", "Agent"],
    disallowed: ["Bash", "WebFetch", "WebSearch", "TodoWrite", "Skill", "NotebookEdit", "ToolSearch"],
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

  return {
    cwd: base.cwd,
    model: base.model,
    systemPrompt: base.agentPrompt
      ? { type: "preset" as const, preset: "claude_code" as const, append: base.agentPrompt }
      : { type: "preset" as const, preset: "claude_code" as const },
    settingSources: ["project"],
    ...(base.maxTurns !== undefined ? { maxTurns: base.maxTurns } : {}),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: tools.allowed,
    disallowedTools: tools.disallowed,
    includePartialMessages: true,
  };
}
