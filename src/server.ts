/**
 * AXME Code MCP Server - stdio transport.
 *
 * Server-side state:
 * - Detects workspace/project from cwd at startup
 * - Provides `instructions` to Claude Code for auto-context loading
 * - Defaults project_path/workspace_path in all tools from cwd
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getFullContext, getOracle, getDecisions } from "./tools/context.js";
import { saveMemoryTool, searchMemoryTool } from "./tools/memory-tools.js";
import { saveDecisionTool } from "./tools/decision-tools.js";
import { updateSafetyTool, showSafetyTool } from "./tools/safety-tools.js";
import { statusTool, worklogTool } from "./tools/status.js";
import { detectWorkspace } from "./utils/workspace-detector.js";

// --- Server state (detected at startup from cwd) ---

const serverCwd = process.cwd();
const serverWorkspace = detectWorkspace(serverCwd);
const isWorkspace = serverWorkspace.type !== "single";
const defaultProjectPath = serverCwd;
const defaultWorkspacePath = isWorkspace ? serverCwd : null;

// --- Build instructions for Claude Code ---

function buildInstructions(): string {
  const parts = [
    "AXME Code MCP server is active.",
    `Project: ${defaultProjectPath}.`,
  ];
  if (isWorkspace) {
    parts.push(`Workspace: ${defaultWorkspacePath} (${serverWorkspace.type}, ${serverWorkspace.projects.length} projects).`);
    parts.push("Call axme_context at session start to load workspace overview.");
    parts.push("Before working with any specific repo, call axme_context with that repo's path.");
  } else {
    parts.push("Call axme_context at session start to load project knowledge base.");
  }
  parts.push("Save memories, decisions, and safety rules immediately when discovered during work.");
  return parts.join(" ");
}

const server = new McpServer(
  { name: "axme", version: "0.1.0" },
  { instructions: buildInstructions() },
);

// --- Helper: resolve paths with defaults from server state ---

function pp(project_path?: string): string {
  return project_path || defaultProjectPath;
}

function wp(workspace_path?: string): string | undefined {
  return workspace_path || defaultWorkspacePath || undefined;
}

// axme_init removed - init only via `axme-code setup` in terminal
// axme_context will detect if project is not initialized and tell the user

// --- axme_context ---
server.tool(
  "axme_context",
  "Read full project context (oracle + decisions + safety + memory + test plan + active plans). Use at session start. Pass workspace_path for merged multi-repo context.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    workspace_path: z.string().optional().describe("Absolute path to workspace root (defaults to detected workspace)"),
  },
  async ({ project_path, workspace_path }) => {
    return { content: [{ type: "text" as const, text: getFullContext(pp(project_path), wp(workspace_path)) }] };
  },
);

// --- axme_oracle ---
server.tool(
  "axme_oracle",
  "Show project oracle data (stack, structure, patterns, glossary).",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
  },
  async ({ project_path }) => {
    return { content: [{ type: "text" as const, text: getOracle(pp(project_path)) }] };
  },
);

// --- axme_decisions ---
server.tool(
  "axme_decisions",
  "Show all project decisions with enforce levels.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
  },
  async ({ project_path }) => {
    return { content: [{ type: "text" as const, text: getDecisions(pp(project_path)) }] };
  },
);

// --- axme_save_memory ---
server.tool(
  "axme_save_memory",
  "Save a feedback or pattern memory. Use 'feedback' for learned mistakes, 'pattern' for successful approaches.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    type: z.enum(["feedback", "pattern"]).describe("Memory type"),
    title: z.string().describe("Short title"),
    description: z.string().describe("One-line description"),
    body: z.string().optional().describe("Detailed explanation with Why and How to apply"),
    keywords: z.array(z.string()).optional().describe("Search keywords"),
    scope: z.array(z.string()).optional().describe("Project scope (omit for current project only)"),
  },
  async ({ project_path, type, title, description, body, keywords, scope }) => {
    const result = saveMemoryTool(pp(project_path), { type, title, description, body, keywords, scope });
    return { content: [{ type: "text" as const, text: `Memory saved: ${result.slug} (${type})` }] };
  },
);

// --- axme_search_memory ---
server.tool(
  "axme_search_memory",
  "Search project memories by keywords. Returns relevant feedback and patterns.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    query: z.string().describe("Search query (keywords)"),
  },
  async ({ project_path, query }) => {
    const result = searchMemoryTool(pp(project_path), query);
    if (result.count === 0) return { content: [{ type: "text" as const, text: "No matching memories found." }] };
    const lines = result.results.map(m => `- **${m.title}** [${m.type}]: ${m.description}`);
    return { content: [{ type: "text" as const, text: `Found ${result.count} memories:\n\n${lines.join("\n")}` }] };
  },
);

// --- axme_save_decision ---
server.tool(
  "axme_save_decision",
  "Save a new architectural decision. Use enforce='required' for rules that must be followed, 'advisory' for recommendations.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    title: z.string().describe("Decision title"),
    decision: z.string().describe("What was decided"),
    reasoning: z.string().describe("Why this decision was made"),
    enforce: z.enum(["required", "advisory"]).optional().describe("Enforcement level"),
    scope: z.array(z.string()).optional().describe("Project scope"),
  },
  async ({ project_path, title, decision, reasoning, enforce, scope }) => {
    const result = saveDecisionTool(pp(project_path), { title, decision, reasoning, enforce, scope });
    return { content: [{ type: "text" as const, text: `Decision saved: ${result.id} - ${title}` }] };
  },
);

// --- axme_update_safety ---
server.tool(
  "axme_update_safety",
  "Add or update a safety rule. Types: git_protected_branch, bash_deny, bash_allow, fs_deny, fs_readonly.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    rule_type: z.enum(["git_protected_branch", "bash_deny", "bash_allow", "fs_deny", "fs_readonly"]).describe("Type of safety rule"),
    value: z.string().describe("Rule value (branch name, command prefix, or file path pattern)"),
  },
  async ({ project_path, rule_type, value }) => {
    const result = updateSafetyTool(pp(project_path), rule_type, value);
    return { content: [{ type: "text" as const, text: `Safety rule added: ${result.ruleType} = ${result.value}` }] };
  },
);

// --- axme_safety ---
server.tool(
  "axme_safety",
  "Show current safety rules (git, bash, filesystem restrictions).",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
  },
  async ({ project_path }) => {
    return { content: [{ type: "text" as const, text: showSafetyTool(pp(project_path)) }] };
  },
);

// --- axme_status ---
server.tool(
  "axme_status",
  "Show project status: oracle, decisions, memories, sessions, last activity.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
  },
  async ({ project_path }) => {
    return { content: [{ type: "text" as const, text: statusTool(pp(project_path)) }] };
  },
);

// --- axme_worklog ---
server.tool(
  "axme_worklog",
  "Show recent worklog events (session starts, check results, memory saves, errors).",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    limit: z.number().optional().describe("Max events to show (default: 20)"),
  },
  async ({ project_path, limit }) => {
    return { content: [{ type: "text" as const, text: worklogTool(pp(project_path), limit) }] };
  },
);

// --- axme_workspace ---
server.tool(
  "axme_workspace",
  "Detect workspace type and list all projects.",
  {
    path: z.string().optional().describe("Absolute path to check (defaults to server cwd)"),
  },
  async ({ path }) => {
    const ws = detectWorkspace(path || serverCwd);
    if (ws.type === "single") {
      return { content: [{ type: "text" as const, text: `Single project (not a workspace): ${ws.root}` }] };
    }
    const lines = [
      `Workspace: ${ws.type}`,
      `Root: ${ws.root}`,
      ws.manifestPath ? `Manifest: ${ws.manifestPath}` : null,
      `Projects (${ws.projects.length}):`,
      ...ws.projects.map(p => `  - ${p.name} (${p.path})`),
    ].filter(Boolean);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`AXME Code MCP server error: ${err}\n`);
  process.exit(1);
});
