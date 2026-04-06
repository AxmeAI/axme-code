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
import {
  findOrphanSessions,
  listClaudeSessionMappings,
  clearClaudeSessionMapping,
  clearLegacyActiveSession,
  clearLegacyPendingAuditsDir,
  readClaudeSessionMapping,
} from "./storage/sessions.js";
import { logEvent } from "./storage/worklog.js";
import { spawnDetachedAuditWorker } from "./audit-spawner.js";

// --- Server state (detected at startup from cwd) ---

const serverCwd = process.cwd();
const serverWorkspace = detectWorkspace(serverCwd);
const isWorkspace = serverWorkspace.type !== "single";
const defaultProjectPath = serverCwd;
const defaultWorkspacePath = isWorkspace ? serverCwd : null;

// The MCP server does NOT create an AXME session at startup. AXME sessions
// are created lazily by hooks on the first tool call — that's when we learn
// the Claude session_id, which is the key for multi-window isolation.
//
// Instead of a single "currentSession", the server owns all AXME sessions
// created by hooks whose parent process id equals our own parent process
// id (i.e., the same Claude Code instance that spawned us). At disconnect,
// we close all of them.
const OWN_PPID = process.ppid;

// Clean up any legacy .axme-code/active-session single-file marker from
// older versions. It is stale by definition after the switch to per-Claude
// mapping files.
clearLegacyActiveSession(defaultProjectPath);
// Same for the legacy .axme-code/pending-audits/ directory: that state now
// lives on SessionMeta.auditStatus, so the directory is dead weight.
clearLegacyPendingAuditsDir(defaultProjectPath);


/**
 * Return the AXME session UUID owned by this MCP server for worklog purposes.
 * If there are multiple owned sessions (shouldn't happen normally), returns
 * the first one. If none, returns undefined — the caller should pass no
 * sessionId to the worklog.
 */
function getOwnedSessionIdForLogging(): string | undefined {
  const owned = listClaudeSessionMappings(defaultProjectPath)
    .filter(m => m.ownerPpid === OWN_PPID);
  return owned[0]?.axmeSessionId;
}

// Session cleanup is triggered by transport.onclose (see main() below) rather
// than process.on("exit") — exit handlers cannot do meaningful work.
//
// CRITICAL: cleanupAndExit DOES NOT run the audit itself. It spawns a detached
// background worker process per owned session and exits immediately. Why:
//
//   VS Code may kill this MCP server process within milliseconds of closing
//   the Claude Code window (especially in center-editor-tab mode where the
//   tab close triggers an immediate SIGKILL, unlike the side-panel mode which
//   gives us more time). Running the audit synchronously here means it dies
//   mid-LLM-call and the session gets stuck at phase="started" forever.
//
//   The detached worker runs in its own process group (setsid via
//   `detached: true`), survives any signal to this server's process group,
//   and reads fresh code from dist/cli.mjs on every spawn — so iteration on
//   the auditor does not require a VS Code window reload.
//
//   The worker is `axme-code audit-session --workspace X --session Y` and
//   it calls the same runSessionCleanup() this file used to call directly.
//   Concurrency is handled by auditStatus="pending" + stale timeout inside
//   runSessionCleanup itself — two workers for the same session cannot both
//   run the LLM, the second will hit "concurrent-audit" skip and exit.

let cleanupRunning = false;
async function cleanupAndExit(reason: string): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;

  // Find all mapping files owned by our Claude Code parent process, spawn a
  // detached audit worker for each, clear the mapping, and exit. No awaiting.
  try {
    const mappings = listClaudeSessionMappings(defaultProjectPath);
    const owned = mappings.filter(m => m.ownerPpid === OWN_PPID);
    process.stderr.write(
      `AXME cleanup (${reason}): ${owned.length} owned session(s) of ${mappings.length} total — spawning detached audit workers\n`,
    );
    for (const m of owned) {
      try {
        spawnDetachedAuditWorker(defaultProjectPath, m.axmeSessionId);
      } catch (err) {
        process.stderr.write(`AXME cleanup: failed to spawn worker for ${m.axmeSessionId}: ${err}\n`);
      }
      try { clearClaudeSessionMapping(defaultProjectPath, m.claudeSessionId); } catch {}
    }
  } catch (err) {
    process.stderr.write(`AXME cleanup scan failed (${reason}): ${err}\n`);
  }
  process.exit(0);
}

// --- Build instructions for Claude Code ---

function buildInstructions(): string {
  const parts = [
    "AXME Code MCP server is active.",
    `Project: ${defaultProjectPath}.`,
  ];
  if (isWorkspace) {
    parts.push(`Workspace: ${defaultWorkspacePath} (${serverWorkspace.type}, ${serverWorkspace.projects.length} projects).`);
    parts.push("Call axme_context at session start to load workspace overview.");
    parts.push("Each repo has its own .axme-code/ storage initialized during setup.");
    parts.push("Before working with any specific repo, call axme_context with that repo's path.");
  } else {
    parts.push("Call axme_context at session start to load project knowledge base.");
  }
  parts.push("Save memories, decisions, and safety rules immediately when discovered during work.");
  parts.push("DECISION CONFLICT RULE: if two active decisions contradict each other, treat the NEWER one (by date) as authoritative. The older one is a candidate for supersede at next audit.");
  parts.push(
    `STORAGE ROOT: ${defaultProjectPath}/.axme-code — for any direct inspection of .axme-code/ files via Bash (ls, cat, grep, find), use this ABSOLUTE path. Do NOT use relative paths from your cwd; in a multi-repo workspace your cwd may point to a child repo with its own separate .axme-code/ storage. Every session's meta.json also contains an "origin" field with its absolute parent directory — read it to verify which storage a given session belongs to.`,
  );
  parts.push(
    "IMPORTANT: if axme_context output contains a '## ⚠️ Pending audits' section, " +
      "a previous session's audit is still running and the knowledge base is incomplete. " +
      "You MUST tell the user, offer to either wait and re-run axme_context or track with a TODO, " +
      "and re-check axme_context periodically until the pending list is empty before relying on the knowledge base.",
  );
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

    const sid = getOwnedSessionIdForLogging();
    const result = saveMemoryTool(pp(project_path), { type, title, description, body, keywords, scope }, sid);
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

// --- axme_ask_question ---
server.tool(
  "axme_ask_question",
  "Record an open question for the next session or KB audit. Use when you find ambiguity that needs user clarification.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    question: z.string().describe("The question text"),
    context: z.string().optional().describe("Related decision IDs, file paths, or other context"),
  },
  async ({ project_path, question, context }) => {
    const { askQuestion } = await import("./storage/questions.js");
    const sid = getOwnedSessionIdForLogging();
    const q = askQuestion(pp(project_path), {
      question,
      context,
      source: sid ? `session-${sid.slice(0, 8)}` : "manual",
    });
    return { content: [{ type: "text" as const, text: `Question recorded: ${q.id} [open]` }] };
  },
);

// --- axme_list_open_questions ---
server.tool(
  "axme_list_open_questions",
  "List open questions that need user answers. Show at session start if any exist.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
  },
  async ({ project_path }) => {
    const { listQuestions } = await import("./storage/questions.js");
    const open = listQuestions(pp(project_path), { status: "open" });
    if (open.length === 0) return { content: [{ type: "text" as const, text: "No open questions." }] };
    const lines = open.map(q => `- **${q.id}**: ${q.question}${q.context ? ` (${q.context})` : ""}`);
    return { content: [{ type: "text" as const, text: `Open questions (${open.length}):\n\n${lines.join("\n")}` }] };
  },
);

// --- axme_answer_question ---
server.tool(
  "axme_answer_question",
  "Record the user's answer to an open question. Changes status from [open] to [answered].",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    question_id: z.string().describe("Question ID (e.g. Q-001)"),
    answer: z.string().describe("The user's answer"),
  },
  async ({ project_path, question_id, answer }) => {
    const { answerQuestion } = await import("./storage/questions.js");
    const q = answerQuestion(pp(project_path), question_id, answer);
    if (!q) return { content: [{ type: "text" as const, text: `Question ${question_id} not found or not open.` }] };
    return { content: [{ type: "text" as const, text: `Answer recorded for ${q.id}. Status: [answered]` }] };
  },
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();

  // Auto-audit on disconnect: when Claude Code closes the stdio pipe, stdin
  // receives EOF. The MCP server process survives (Claude Code is known to
  // not kill child MCP servers on exit, issue #1935), giving us time to run
  // the full LLM audit before we exit ourselves.
  //
  // Note: we listen on process.stdin directly because MCP SDK's
  // StdioServerTransport only handles 'data' and 'error' events — it does
  // not react to stdin 'end'/'close', so transport.onclose never fires on
  // its own. This bypasses that limitation.
  process.stdin.on("end", () => { void cleanupAndExit("stdin-end"); });
  process.stdin.on("close", () => { void cleanupAndExit("stdin-close"); });

  process.on("SIGINT", () => { void cleanupAndExit("sigint"); });
  process.on("SIGTERM", () => { void cleanupAndExit("sigterm"); });
  process.on("SIGHUP", () => { void cleanupAndExit("sighup"); });

  await server.connect(transport);

  // Startup fallback: audit any orphaned sessions left behind by previous
  // MCP servers that were killed before auto-audit could run (e.g. SIGKILL
  // from VS Code force-close). Runs in the background so it does not block
  // server startup.
  setTimeout(() => {
    void auditOrphansInBackground();
  }, 3000);
}

async function auditOrphansInBackground(): Promise<void> {
  try {
    // Find orphaned sessions (closedAt=null, pid belongs to a dead Claude Code
    // process, not yet audited, under retry cap). Skip any session that is
    // currently owned by this MCP server via an active mapping file.
    const ownedAxmeIds = new Set(
      listClaudeSessionMappings(defaultProjectPath)
        .filter(m => m.ownerPpid === OWN_PPID)
        .map(m => m.axmeSessionId),
    );

    const orphans = findOrphanSessions(defaultProjectPath);
    for (const orphan of orphans) {
      if (ownedAxmeIds.has(orphan.id)) continue; // never touch our own active sessions
      // Spawn a detached worker instead of awaiting runSessionCleanup inline.
      // Same reasoning as cleanupAndExit: the MCP server can be killed by VS
      // Code at any time, and we do not want orphan audits to die mid-run.
      // logEvent is fire-and-forget here — the worker will write its own
      // session_end / audit log when it completes.
      try {
        spawnDetachedAuditWorker(defaultProjectPath, orphan.id);
        logEvent(defaultProjectPath, "session_orphan_audit_queued", orphan.id, {
          filesChanged: orphan.filesChanged.length,
          closedByPpid: OWN_PPID,
          workerSpawned: true,
        });
      } catch (err) {
        process.stderr.write(`AXME orphan audit: failed to spawn worker for ${orphan.id}: ${err}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`AXME orphan scan failed: ${err}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`AXME Code MCP server error: ${err}\n`);
  process.exit(1);
});
