/**
 * AXME Code MCP Server - stdio transport.
 *
 * Provides tools for project knowledge, testing, review, and memory.
 * Runs as a subprocess of Claude Code CLI via .mcp.json.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { initProject } from "./tools/init.js";
import { getFullContext, getOracle, getDecisions } from "./tools/context.js";
import { saveMemoryTool, searchMemoryTool } from "./tools/memory-tools.js";
import { saveDecisionTool } from "./tools/decision-tools.js";
import { updateSafetyTool, showSafetyTool } from "./tools/safety-tools.js";
import { statusTool, worklogTool } from "./tools/status.js";

const server = new McpServer({
  name: "axme",
  version: "0.1.0",
});

// --- axme_init ---
server.tool(
  "axme_init",
  "Initialize project knowledge base. Creates .axme-code/ with oracle, decisions, memory, safety rules, and config. Run this first in any new project.",
  {
    project_path: z.string().describe("Absolute path to the project root"),
    presets: z.array(z.string()).optional().describe("Preset bundle IDs to apply (default: essential-safety, ai-agent-guardrails)"),
  },
  async ({ project_path, presets }) => {
    const result = initProject(project_path, { presets });
    const status = result.created ? "Created" : "Updated";
    return {
      content: [{
        type: "text" as const,
        text: [
          `${status} .axme-code/ in ${result.projectPath}`,
          `Oracle: ${result.oracle.files} files`,
          `Decisions: ${result.decisions.count} (${result.decisions.fromPresets} from presets)`,
          `Memories: ${result.memories.count} (${result.memories.fromPresets} from presets)`,
          `Safety: ${result.safety ? "created" : "exists"}`,
          `Config: ${result.config ? "created" : "exists"}`,
          "",
          "Project initialized. Use axme_context to read the knowledge base.",
        ].join("\n"),
      }],
    };
  },
);

// --- axme_context ---
server.tool(
  "axme_context",
  "Read full project context (oracle + decisions + safety + memory). Use this at the start of each task to understand the project.",
  {
    project_path: z.string().describe("Absolute path to the project root"),
  },
  async ({ project_path }) => {
    return { content: [{ type: "text" as const, text: getFullContext(project_path) }] };
  },
);

// --- axme_oracle ---
server.tool(
  "axme_oracle",
  "Show project oracle data (stack, structure, patterns, glossary).",
  {
    project_path: z.string().describe("Absolute path to the project root"),
  },
  async ({ project_path }) => {
    return { content: [{ type: "text" as const, text: getOracle(project_path) }] };
  },
);

// --- axme_decisions ---
server.tool(
  "axme_decisions",
  "Show all project decisions with enforce levels.",
  {
    project_path: z.string().describe("Absolute path to the project root"),
  },
  async ({ project_path }) => {
    return { content: [{ type: "text" as const, text: getDecisions(project_path) }] };
  },
);

// --- axme_save_memory ---
server.tool(
  "axme_save_memory",
  "Save a feedback or pattern memory. Use 'feedback' for learned mistakes, 'pattern' for successful approaches.",
  {
    project_path: z.string().describe("Absolute path to the project root"),
    type: z.enum(["feedback", "pattern"]).describe("Memory type"),
    title: z.string().describe("Short title"),
    description: z.string().describe("One-line description"),
    body: z.string().optional().describe("Detailed explanation with Why and How to apply"),
    keywords: z.array(z.string()).optional().describe("Search keywords"),
    scope: z.array(z.string()).optional().describe("Project scope (omit for current project only)"),
  },
  async ({ project_path, type, title, description, body, keywords, scope }) => {
    const result = saveMemoryTool(project_path, { type, title, description, body, keywords, scope });
    return {
      content: [{
        type: "text" as const,
        text: `Memory saved: ${result.slug} (${type})`,
      }],
    };
  },
);

// --- axme_search_memory ---
server.tool(
  "axme_search_memory",
  "Search project memories by keywords. Returns relevant feedback and patterns.",
  {
    project_path: z.string().describe("Absolute path to the project root"),
    query: z.string().describe("Search query (keywords)"),
  },
  async ({ project_path, query }) => {
    const result = searchMemoryTool(project_path, query);
    if (result.count === 0) {
      return { content: [{ type: "text" as const, text: "No matching memories found." }] };
    }
    const lines = result.results.map(m => `- **${m.title}** [${m.type}]: ${m.description}`);
    return {
      content: [{
        type: "text" as const,
        text: `Found ${result.count} memories:\n\n${lines.join("\n")}`,
      }],
    };
  },
);

// --- axme_save_decision ---
server.tool(
  "axme_save_decision",
  "Save a new architectural decision. Use enforce='required' for rules that must be followed, 'advisory' for recommendations.",
  {
    project_path: z.string().describe("Absolute path to the project root"),
    title: z.string().describe("Decision title"),
    decision: z.string().describe("What was decided"),
    reasoning: z.string().describe("Why this decision was made"),
    enforce: z.enum(["required", "advisory"]).optional().describe("Enforcement level"),
    scope: z.array(z.string()).optional().describe("Project scope"),
  },
  async ({ project_path, title, decision, reasoning, enforce, scope }) => {
    const result = saveDecisionTool(project_path, { title, decision, reasoning, enforce, scope });
    return {
      content: [{
        type: "text" as const,
        text: `Decision saved: ${result.id} - ${title}`,
      }],
    };
  },
);

// --- axme_update_safety ---
server.tool(
  "axme_update_safety",
  "Add or update a safety rule. Types: git_protected_branch, bash_deny, bash_allow, fs_deny, fs_readonly.",
  {
    project_path: z.string().describe("Absolute path to the project root"),
    rule_type: z.enum(["git_protected_branch", "bash_deny", "bash_allow", "fs_deny", "fs_readonly"]).describe("Type of safety rule"),
    value: z.string().describe("Rule value (branch name, command prefix, or file path pattern)"),
  },
  async ({ project_path, rule_type, value }) => {
    const result = updateSafetyTool(project_path, rule_type, value);
    return {
      content: [{
        type: "text" as const,
        text: `Safety rule added: ${result.ruleType} = ${result.value}`,
      }],
    };
  },
);

// --- axme_safety ---
server.tool(
  "axme_safety",
  "Show current safety rules (git, bash, filesystem restrictions).",
  {
    project_path: z.string().describe("Absolute path to the project root"),
  },
  async ({ project_path }) => {
    return { content: [{ type: "text" as const, text: showSafetyTool(project_path) }] };
  },
);

// --- axme_status ---
server.tool(
  "axme_status",
  "Show project status: oracle, decisions, memories, sessions, last activity.",
  {
    project_path: z.string().describe("Absolute path to the project root"),
  },
  async ({ project_path }) => {
    return { content: [{ type: "text" as const, text: statusTool(project_path) }] };
  },
);

// --- axme_worklog ---
server.tool(
  "axme_worklog",
  "Show recent worklog events (session starts, check results, memory saves, errors).",
  {
    project_path: z.string().describe("Absolute path to the project root"),
    limit: z.number().optional().describe("Max events to show (default: 20)"),
  },
  async ({ project_path, limit }) => {
    return { content: [{ type: "text" as const, text: worklogTool(project_path, limit) }] };
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
