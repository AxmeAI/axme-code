/**
 * AXME Code MCP Server - stdio transport.
 *
 * Server-side state:
 * - Detects workspace/project from cwd at startup
 * - Provides `instructions` to Claude Code for auto-context loading
 * - Defaults project_path/workspace_path in all tools from cwd
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getFullContextSections, getOracle, getDecisions } from "./tools/context.js";
import { allMemoryContext, getMemorySections } from "./storage/memory.js";
import { getOracleSections } from "./storage/oracle.js";
import { getDecisionSections } from "./storage/decisions.js";
import { paginateSections } from "./utils/pagination.js";
import { saveMemoryTool } from "./tools/memory-tools.js";
import { saveDecisionTool } from "./tools/decision-tools.js";
import { updateSafetyTool, showSafetyTool } from "./tools/safety-tools.js";
import { statusTool, worklogTool } from "./tools/status.js";
import { detectWorkspace } from "./utils/workspace-detector.js";
import {
  findOrphanSessions,
  listClaudeSessionMappings,
  writeClaudeSessionMapping,
  clearClaudeSessionMapping,
  clearLegacyActiveSession,
  clearLegacyPendingAuditsDir,
  readClaudeSessionMapping,
  isPidAlive,
  loadSession,
  closeSession,
} from "./storage/sessions.js";
import { logEvent } from "./storage/worklog.js";
import { spawnDetachedAuditWorker } from "./audit-spawner.js";

// --- Server state (detected at startup from cwd) ---

const serverCwd = process.cwd();
const serverHasGit = existsSync(join(serverCwd, ".git"));
const serverWorkspace = detectWorkspace(serverCwd);
const isWorkspace = serverHasGit ? false : serverWorkspace.type !== "single";
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

// Track which context paths have been delivered in this MCP session.
// Used by axme_oracle/decisions/memories to avoid duplicating workspace
// data when a repo-level call follows a workspace-level call.
// Key format: "oracle:<path>", "decisions:<path>", "memories:<path>"
const deliveredContext = new Set<string>();

// Clean up any legacy .axme-code/active-session single-file marker from
// older versions. It is stale by definition after the switch to per-Claude
// mapping files.
clearLegacyActiveSession(defaultProjectPath);
// Same for the legacy .axme-code/pending-audits/ directory: that state now
// lives on SessionMeta.auditStatus, so the directory is dead weight.
clearLegacyPendingAuditsDir(defaultProjectPath);

// Start background auto-update check (non-blocking, never crashes server)
import { backgroundAutoUpdate, getUpdateNotification } from "./auto-update.js";
backgroundAutoUpdate().catch(() => {});

// Send anonymous startup telemetry (install/startup/update) — never throws.
// We do not await here because server.ts is a top-level module side-effect;
// the event loop has plenty of time during MCP server lifetime to flush.
import { sendStartupEvents } from "./telemetry.js";
void sendStartupEvents();


/**
 * Return the AXME session UUID owned by this MCP server for worklog purposes.
 * If there are multiple owned sessions (shouldn't happen normally), returns
 * the first one.
 *
 * Session recovery: if no mapping matches OWN_PPID (e.g. after VS Code reload
 * where a new Claude Code process spawned this MCP server but the old mapping
 * still points to the previous PID), we adopt stale mappings whose ownerPpid
 * is dead. This ensures MCP tools work without requiring a hook-triggering
 * built-in tool call first.
 */
function getOwnedSessionIdForLogging(): string | undefined {
  const all = listClaudeSessionMappings(defaultProjectPath);
  const owned = all.filter(m => m.ownerPpid === OWN_PPID);
  if (owned.length > 0) return owned[0].axmeSessionId;

  // No mapping for our PID — check for stale mappings from dead Claude Code
  // processes and adopt them. This handles VS Code reload where the old
  // Claude Code process died but its mapping file persists.
  for (const m of all) {
    if (m.ownerPpid != null && !isPidAlive(m.ownerPpid)) {
      writeClaudeSessionMapping(defaultProjectPath, m.claudeSessionId, m.axmeSessionId);
      process.stderr.write(
        `AXME: adopted stale mapping ${m.claudeSessionId.slice(0, 8)} ` +
        `(old ppid=${m.ownerPpid}, new ppid=${OWN_PPID})\n`,
      );
      return m.axmeSessionId;
    }
  }

  return undefined;
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

    // Deduplicate: group AXME sessions by Claude session ID.
    // Multiple AXME sessions can share the same Claude session (race condition
    // from parallel hooks). Only audit one per Claude session — the newest.
    const claudeToAxme = new Map<string, { axmeId: string; createdAt: number }[]>();
    for (const m of owned) {
      const session = loadSession(defaultProjectPath, m.axmeSessionId);
      if (!session) continue;
      for (const ref of session.claudeSessions ?? []) {
        const list = claudeToAxme.get(ref.id) ?? [];
        list.push({ axmeId: m.axmeSessionId, createdAt: Date.parse(session.createdAt) || 0 });
        claudeToAxme.set(ref.id, list);
      }
    }
    const toAudit = new Set<string>();
    const toSkip = new Set<string>();
    for (const [, entries] of claudeToAxme) {
      entries.sort((a, b) => b.createdAt - a.createdAt); // newest first
      toAudit.add(entries[0].axmeId);
      for (let i = 1; i < entries.length; i++) toSkip.add(entries[i].axmeId);
    }
    // Mark duplicates as done so they don't linger
    for (const skipId of toSkip) {
      try { closeSession(defaultProjectPath, skipId); } catch {}
    }

    process.stderr.write(
      `AXME cleanup (${reason}): ${owned.length} owned, ${toAudit.size} to audit, ${toSkip.size} deduped\n`,
    );
    for (const m of owned) {
      if (!toAudit.has(m.axmeSessionId)) {
        try { clearClaudeSessionMapping(defaultProjectPath, m.claudeSessionId); } catch {}
        continue;
      }
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
    parts.push("Call axme_context at session start to load workspace overview. It returns compact meta and instructions to call axme_oracle, axme_decisions, axme_memories in parallel.");
    parts.push("Each repo has its own .axme-code/ storage initialized during setup.");
    parts.push("Before working with any specific repo, call axme_context with that repo's path.");
  } else {
    parts.push("Call axme_context at session start. It returns compact meta and instructions to call axme_oracle, axme_decisions, axme_memories in parallel.");
  }
  parts.push("TRUNCATED OUTPUT RULE: if ANY MCP tool output is truncated or saved to a file (you see 'Output too large' or 'saved to file'), you MUST use the Read tool to read the full file content into your context. Do not proceed with partial data.");
  parts.push("Save memories, decisions, and safety rules immediately when discovered during work.");
  parts.push("GIT COMMIT/PUSH GATE: every git commit and git push command MUST end with `#!axme pr=<NUMBER|none> repo=<OWNER/REPO>`. Example: `git commit -m \"fix bug\" #!axme pr=42 repo=AxmeAI/axme-code`. Use pr=none if no PR exists yet. Without this suffix the command will be blocked.");
  parts.push("RELEASE/TAG PROHIBITION: agent must NEVER run git tag, npm publish, twine upload, dotnet nuget push, mvn deploy, gh release create, or gh workflow run deploy-prod. These are blocked by safety hooks. To release: prepare version bump + CHANGELOG + PR, then provide ready-to-run tag/publish commands to the user.");
  parts.push("SESSION CLOSE: when the user asks to close/end the session (any language), call axme_begin_close to get the close checklist. Follow it: extract memories/decisions/safety (choosing correct scope for each), prepare handoff data, then call axme_finalize_close with everything. After finalize, output to the user: storage summary (what saved where), then startup_text.");
  parts.push("DECISION CONFLICT RULE: if two active decisions contradict each other, treat the NEWER one (by date) as authoritative. The older one is a candidate for supersede at next audit.");
  parts.push(
    `STORAGE ROOT: ${defaultProjectPath}/.axme-code — for any direct inspection of .axme-code/ files via Bash (ls, cat, grep, find), use this ABSOLUTE path. Do NOT use relative paths from your cwd; in a multi-repo workspace your cwd may point to a child repo with its own separate .axme-code/ storage.`,
  );
  parts.push(
    "IMPORTANT: if axme_context output contains a 'Pending audits' section, " +
      "a previous session's audit is still running and the knowledge base is incomplete. " +
      "Tell the user, offer to wait and re-run axme_context or track with a TODO.",
  );
  return parts.join(" ");
}

const server = new McpServer(
  { name: "axme", version: "0.1.0" },
  { instructions: buildInstructions() },
);

// Wrap every tool handler with a try/catch that reports caught exceptions to
// telemetry under the `mcp_tool` category. We monkey-patch server.tool() once
// here instead of touching all 19 individual tool registrations below. The
// MCP SDK still receives any thrown error and returns it to the client, so
// no behavior changes — we only add an extra observability hook.
//
// Why fatal=true: an exception that bubbles out of a tool handler means the
// tool call did not complete its intended work — the user-visible operation
// has aborted. That matches our "fatal vs degraded" definition.
const _origRegisterTool: any = server.tool.bind(server);
(server as any).tool = function (...args: any[]): any {
  // Last argument is always the handler function
  const handler = args[args.length - 1];
  if (typeof handler === "function") {
    args[args.length - 1] = async (...handlerArgs: any[]): Promise<any> => {
      try {
        return await handler(...handlerArgs);
      } catch (err) {
        try {
          const { reportError, classifyError } = await import("./telemetry.js");
          reportError("mcp_tool", classifyError(err), true);
        } catch { /* never throw from telemetry */ }
        throw err;
      }
    };
  }
  return _origRegisterTool.apply(server, args);
};

// --- Helper: resolve paths with defaults from server state ---

function pp(project_path?: string): string {
  return project_path || defaultProjectPath;
}

/**
 * Resolve project_path from scope when project_path is not explicitly provided.
 * If scope contains a specific repo name (not "all"), resolve to workspace/repo-name.
 * Falls back to pp() default behavior.
 */
function ppWithScope(project_path?: string, scope?: string[]): string {
  if (project_path) return project_path;
  if (isWorkspace && scope && scope.length > 0) {
    const repoScope = scope.find(s => s !== "all");
    if (repoScope) {
      const match = serverWorkspace.projects.find(p => p.name === repoScope);
      if (match) return join(defaultProjectPath, match.path);
    }
    // scope: ["all"] or no match -> workspace root
  }
  return defaultProjectPath;
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
    page: z.number().optional().describe("Page number (1-based). Omit for first page. Follow pagination instructions if output is split."),
  },
  async ({ project_path, workspace_path, page }) => {
    const sections = getFullContextSections(pp(project_path), wp(workspace_path));
    // Inject auto-update notification if available (first page only)
    const updateMsg = getUpdateNotification();
    if (updateMsg && (!page || page === 1)) {
      sections.unshift(`**Update**: ${updateMsg}`);
    }
    const result = paginateSections(sections, page ?? 1, "axme_context", { project_path, workspace_path });
    return { content: [{ type: "text" as const, text: result.text }] };
  },
);

// --- axme_oracle ---
server.tool(
  "axme_oracle",
  "Show project oracle data (stack, structure, patterns, glossary).",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    page: z.number().optional().describe("Page number (1-based). Omit for first page. Follow pagination instructions if output is split."),
  },
  async ({ project_path, page }) => {
    const resolved = pp(project_path);
    deliveredContext.add("oracle:" + resolved);
    let sections = getOracleSections(resolved);
    // If requesting repo oracle and workspace oracle was already delivered, return repo-only
    if (isWorkspace && defaultWorkspacePath && resolved !== defaultWorkspacePath
        && deliveredContext.has("oracle:" + defaultWorkspacePath)) {
      sections = [...sections, "*(Workspace oracle already loaded)*"];
    }
    const result = paginateSections(sections, page ?? 1, "axme_oracle", { project_path });
    return { content: [{ type: "text" as const, text: result.text }] };
  },
);

// --- axme_decisions ---
server.tool(
  "axme_decisions",
  "Show all project decisions with enforce levels.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    page: z.number().optional().describe("Page number (1-based). Omit for first page. Follow pagination instructions if output is split."),
  },
  async ({ project_path, page }) => {
    const resolved = pp(project_path);
    deliveredContext.add("decisions:" + resolved);
    let sections = getDecisionSections(resolved);
    // If requesting repo decisions and workspace decisions already delivered, return repo-only
    if (isWorkspace && defaultWorkspacePath && resolved !== defaultWorkspacePath
        && deliveredContext.has("decisions:" + defaultWorkspacePath)) {
      sections = [...sections, "*(Workspace decisions already loaded)*"];
    }
    const result = paginateSections(sections, page ?? 1, "axme_decisions", { project_path });
    return { content: [{ type: "text" as const, text: result.text }] };
  },
);

// --- axme_memories ---
server.tool(
  "axme_memories",
  "Show all project memories (feedback + patterns). Call at session start alongside axme_oracle and axme_decisions.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    page: z.number().optional().describe("Page number (1-based). Omit for first page. Follow pagination instructions if output is split."),
  },
  async ({ project_path, page }) => {
    const resolved = pp(project_path);
    deliveredContext.add("memories:" + resolved);

    let sections: string[];

    // If requesting repo memories and workspace memories already delivered: repo-only
    if (isWorkspace && defaultWorkspacePath && resolved !== defaultWorkspacePath
        && deliveredContext.has("memories:" + defaultWorkspacePath)) {
      sections = getMemorySections(resolved);
      if (sections.length === 0) sections = ["No repo-specific memories."];
      sections.push("*(Workspace memories already loaded)*");
    }
    // If requesting repo memories but workspace NOT yet delivered: merged (workspace + repo)
    else if (isWorkspace && defaultWorkspacePath && resolved !== defaultWorkspacePath) {
      const { listMemories } = await import("./storage/memory.js");
      const { mergeMemories } = await import("./storage/workspace-merge.js");
      const wsMemories = listMemories(defaultWorkspacePath);
      const projMemories = listMemories(resolved);
      const merged = mergeMemories(wsMemories, projMemories);
      if (merged.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories recorded." }] };
      }
      const feedbacks = merged.filter(m => m.type === "feedback");
      const patterns = merged.filter(m => m.type === "pattern");
      sections = ["## Project Memories (workspace + repo merged)"];
      if (feedbacks.length > 0) {
        sections.push(`### Feedback (${feedbacks.length}):\n` +
          feedbacks.map(m => `- **${m.title}**: ${m.description}`).join("\n"));
      }
      if (patterns.length > 0) {
        sections.push(`### Patterns (${patterns.length}):\n` +
          patterns.map(m => `- **${m.title}**: ${m.description}`).join("\n"));
      }
    }
    // Workspace call or single-repo: return as-is
    else {
      sections = getMemorySections(resolved);
      if (sections.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories recorded." }] };
      }
      sections = ["## Project Memories", ...sections];
    }

    const result = paginateSections(sections, page ?? 1, "axme_memories", { project_path });
    return { content: [{ type: "text" as const, text: result.text }] };
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
    description: z.string().describe("1-2 sentences: what happened + specific action/command/rule. Must be self-contained without body."),
    body: z.string().optional().describe("Optional archive detail. Context output uses description only, so put all essential info there."),
    keywords: z.array(z.string()).optional().describe("Search keywords"),
    scope: z.array(z.string()).optional().describe("Project scope (omit for current project only)"),
  },
  async ({ project_path, type, title, description, body, keywords, scope }) => {

    const sid = getOwnedSessionIdForLogging();
    const resolved = ppWithScope(project_path, scope);
    const result = saveMemoryTool(resolved, { type, title, description, body, keywords, scope }, sid);
    return { content: [{ type: "text" as const, text: `Memory saved: ${result.slug} (${type}) -> ${resolved}` }] };
  },
);

// --- axme_save_decision ---
server.tool(
  "axme_save_decision",
  "Save a new architectural decision. Use enforce='required' for rules that must be followed, 'advisory' for recommendations.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    title: z.string().describe("Decision title"),
    decision: z.string().describe("2-3 sentences: what was decided + why. Must be self-contained."),
    reasoning: z.string().describe("Optional additional context. Context output uses decision field only."),
    enforce: z.enum(["required", "advisory"]).optional().describe("Enforcement level"),
    scope: z.array(z.string()).optional().describe("Project scope"),
  },
  async ({ project_path, title, decision, reasoning, enforce, scope }) => {

    const resolved = ppWithScope(project_path, scope);
    const result = saveDecisionTool(resolved, { title, decision, reasoning, enforce, scope });
    return { content: [{ type: "text" as const, text: `Decision saved: ${result.id} - ${title} -> ${resolved}` }] };
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
    const sid = getOwnedSessionIdForLogging();
    const result = updateSafetyTool(pp(project_path), rule_type, value, sid ?? undefined);
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

// --- axme_backlog ---
server.tool(
  "axme_backlog",
  "List or read backlog items. Persistent cross-session task tracking.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    status: z.enum(["open", "in-progress", "done", "blocked"]).optional().describe("Filter by status. Omit to show all."),
    id: z.string().optional().describe("Get a specific item by ID (e.g. B-001) or slug."),
  },
  async ({ project_path, status, id }) => {
    const { showBacklog, getBacklogItem } = await import("./storage/backlog.js");
    const resolved = pp(project_path);
    if (id) {
      const item = getBacklogItem(resolved, id);
      if (!item) return { content: [{ type: "text" as const, text: `Backlog item "${id}" not found.` }] };
      const tags = item.tags.length > 0 ? `\nTags: ${item.tags.join(", ")}` : "";
      const scope = item.scope?.length ? `\nScope: ${item.scope.join(", ")}` : "";
      const notes = item.notes ? `\n\n## Notes\n${item.notes}` : "";
      return { content: [{ type: "text" as const, text: `# ${item.id}: ${item.title}\n\nStatus: ${item.status} | Priority: ${item.priority} | Created: ${item.created} | Updated: ${item.updated}${tags}${scope}\n\n${item.description}${notes}` }] };
    }
    return { content: [{ type: "text" as const, text: showBacklog(resolved, status as any) }] };
  },
);

// --- axme_backlog_add ---
server.tool(
  "axme_backlog_add",
  "Add a new backlog item. Use for tasks, features, bugs that should persist across sessions.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    title: z.string().describe("Short title for the backlog item"),
    description: z.string().describe("Detailed description of the task/feature/bug"),
    priority: z.enum(["high", "medium", "low"]).optional().describe("Priority level (default: medium)"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    scope: z.array(z.string()).optional().describe("Project scope (e.g. [\"all\"] for workspace, [\"repo-name\"] for specific repo)"),
  },
  async ({ project_path, title, description, priority, tags, scope }) => {
    const { addBacklogItem } = await import("./storage/backlog.js");
    const resolved = ppWithScope(project_path, scope);
    const item = addBacklogItem(resolved, { title, description, priority: priority as any, tags, scope });
    return { content: [{ type: "text" as const, text: `Backlog item created: ${item.id} - ${item.title} (${item.priority})` }] };
  },
);

// --- axme_backlog_update ---
server.tool(
  "axme_backlog_update",
  "Update a backlog item status, priority, or add notes.",
  {
    project_path: z.string().optional().describe("Absolute path to the project root (defaults to server cwd)"),
    id: z.string().describe("Item ID (e.g. B-001) or slug"),
    status: z.enum(["open", "in-progress", "done", "blocked"]).optional().describe("New status"),
    priority: z.enum(["high", "medium", "low"]).optional().describe("New priority"),
    notes: z.string().optional().describe("Additional notes to append"),
  },
  async ({ project_path, id, status, priority, notes }) => {
    const { updateBacklogItem } = await import("./storage/backlog.js");
    const item = updateBacklogItem(pp(project_path), id, { status: status as any, priority: priority as any, notes });
    if (!item) return { content: [{ type: "text" as const, text: `Backlog item "${id}" not found.` }] };
    return { content: [{ type: "text" as const, text: `Updated ${item.id}: ${item.title} -> ${item.status} (${item.priority})` }] };
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
  "Record a question that ONLY the user can answer - architectural choices, product decisions, ambiguous requirements. NOT for bugs, TODOs, tasks, or findings - those belong in the conversation or TODO list. Example: 'Should we support backwards compatibility with v1 API?' Anti-example: 'There is a bug in extractBashWritePaths' (that is a bug, not a question for the user).",
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

// --- axme_begin_close ---
server.tool(
  "axme_begin_close",
  "Start session close process. Call when user says 'close session' / 'end session' / '\u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0439 \u0441\u0435\u0441\u0441\u0438\u044E'. Returns extraction checklist. Follow it, then call axme_finalize_close with everything.",
  {},
  async () => {
    const sid = getOwnedSessionIdForLogging();
    if (!sid) {
      return { content: [{ type: "text" as const, text: "No active AXME session found." }] };
    }

    const checklist = [
      `# Session Close Checklist (session ${sid.slice(0, 8)})`,
      "",
      "## Step 1: Extract Knowledge",
      "",
      "Review your ENTIRE session for knowledge worth preserving.",
      "Save items the user explicitly confirmed. For uncertain items, ask the user before saving.",
      "",
      "### Scope rules:",
      "- Workspace-wide (git safety, deploy procedures, auth model, cross-repo conventions) -> `scope: [\"all\"]`",
      "- Repo-specific (test patterns, build config, API design for one service) -> omit scope or `scope: [\"<repo-name>\"]`",
      "- If you worked in multiple repos: split items by repo, each gets the scope where it applies",
      "",
      "### What to extract:",
      "- **Memories** (feedback from user corrections, validated patterns)",
      "- **Decisions** (policies user confirmed, architectural choices)",
      "- **Safety rules** (user mandated bash_deny, fs_deny, git_protected_branch, etc.)",
      "",
      "### Dedup & conflict check (MANDATORY for each item):",
      "Compare every candidate against what you already loaded via `axme_context`.",
      "If writing to a repo you haven't loaded yet, call `axme_context` for it first.",
      "You already have the full list of memories, decisions, and safety rules in context.",
      "",
      "**Exact duplicate** (same concept, different wording): skip, do NOT add.",
      "**Same topic, updated info**: action `supersede` with the old slug/id.",
      "**Direct contradiction**: action `supersede` on the older item (newer is authoritative).",
      "**Unclear contradiction**: ask the user which to keep before adding.",
      "**Outdated item found** (even unrelated to new ones): action `remove` with its slug/id.",
      "",
      "## Step 2: Prepare Everything for `axme_finalize_close`",
      "",
      "Collect ALL data into a single `axme_finalize_close` call:",
      "",
      "### Extractions (arrays, can be empty):",
      "- `memories`: [{action, type, title, description, body, keywords, scope}]",
      "  - action: `add` | `remove` (slug required) | `supersede` (slug required + new data)",
      "- `decisions`: [{action, title, decision, reasoning, enforce, scope}]",
      "  - action: `add` | `remove` (id required) | `supersede` (id required + new data)",
      "- `safety_rules`: [{action, rule_type, value}]",
      "  - action: `add` | `remove`",
      "",
      "### Handoff:",
      "- `stopped_at`: what the session stopped at (single line)",
      "- `summary`: 2-5 bullet points of what was accomplished",
      "- `in_progress`: current state (branches, PRs, uncommitted work)",
      "- `prs`: [{url, title, status}]",
      "- `test_results`, `blockers`, `dirty_branches` (optional)",
      "- `next_steps`: concrete next steps",
      "- `worklog_entry`: narrative summary (5-15 lines markdown)",
      "- `startup_text`: ready-to-paste text for next session",
      "",
      "## Step 3: Call `axme_finalize_close`",
      "",
      "Pass everything in one call. MCP writes all files atomically.",
      "After it returns:",
      "1. Verify handoff.md was written: `ls .axme-code/plans/handoff.md`",
      "2. Output to the user: storage summary, then startup_text.",
    ];

    return { content: [{ type: "text" as const, text: checklist.join("\n") }] };
  },
);

// --- axme_finalize_close ---
server.tool(
  "axme_finalize_close",
  "Finalize session close: saves extractions, writes handoff + worklog, sets agentClosed flag. Call with ALL data after completing the checklist from axme_begin_close.",
  {
    // --- Extractions ---
    memories: z.array(z.object({
      action: z.enum(["add", "remove", "supersede"]),
      slug: z.string().optional().describe("Required for remove/supersede: slug of existing memory"),
      type: z.enum(["feedback", "pattern"]).optional().describe("Required for add/supersede"),
      title: z.string().optional().describe("Required for add/supersede"),
      description: z.string().optional().describe("Required for add/supersede"),
      body: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      scope: z.array(z.string()).optional(),
    })).optional().describe("Memories to add/remove/supersede"),
    decisions: z.array(z.object({
      action: z.enum(["add", "remove", "supersede"]),
      id: z.string().optional().describe("Required for remove/supersede: decision ID (e.g. D-042)"),
      title: z.string().optional().describe("Required for add/supersede"),
      decision: z.string().optional().describe("Required for add/supersede"),
      reasoning: z.string().optional().describe("Required for add/supersede"),
      enforce: z.enum(["required", "advisory"]).optional(),
      scope: z.array(z.string()).optional(),
    })).optional().describe("Decisions to add/remove/supersede"),
    safety_rules: z.array(z.object({
      action: z.enum(["add", "remove"]),
      rule_type: z.enum(["git_protected_branch", "bash_deny", "bash_allow", "fs_deny", "fs_readonly"]),
      value: z.string(),
    })).optional().describe("Safety rules to add/remove"),
    // --- Handoff ---
    stopped_at: z.string().describe("What the session stopped at (single line)"),
    summary: z.string().describe("2-5 bullet points of what was accomplished. Use real newlines, NOT literal backslash-n. Each bullet on its own line starting with '- '."),
    in_progress: z.string().describe("Current state: branches, PRs, uncommitted work. Use real newlines, NOT literal backslash-n."),
    prs: z.array(z.object({
      url: z.string(),
      title: z.string(),
      status: z.string(),
    })).optional().describe("PRs created/merged in this session"),
    test_results: z.string().optional().describe("Test run summary"),
    blockers: z.string().optional().describe("Blockers for next session"),
    next_steps: z.string().describe("Concrete next steps for next session. Use real newlines, NOT literal backslash-n."),
    dirty_branches: z.string().optional().describe("Branch names with state"),
    worklog_entry: z.string().describe("Narrative session summary (5-15 lines markdown). Use real newlines, NOT literal backslash-n."),
    startup_text: z.string().describe("Ready-to-paste startup text for the next session"),
  },
  async (args) => {
    const sid = getOwnedSessionIdForLogging();
    if (!sid) {
      return { content: [{ type: "text" as const, text: "No active AXME session found." }] };
    }

    const targetPath = defaultProjectPath;
    const report: string[] = [];

    // 1. Process extractions
    const { saveMemoryTool } = await import("./tools/memory-tools.js");
    const { saveDecisionTool } = await import("./tools/decision-tools.js");
    const { updateSafetyTool } = await import("./tools/safety-tools.js");
    const { deleteMemory } = await import("./storage/memory.js");
    const { supersedeDecision, revokeDecision } = await import("./storage/decisions.js");

    // Memories
    if (args.memories && args.memories.length > 0) {
      for (const m of args.memories) {
        try {
          if (m.action === "add" && m.type && m.title && m.description) {
            const mPath = ppWithScope(undefined, m.scope);
            const result = saveMemoryTool(mPath, {
              type: m.type, title: m.title, description: m.description,
              body: m.body, keywords: m.keywords, scope: m.scope,
            }, sid);
            report.push(`Memory added: ${result.slug}`);
          } else if (m.action === "remove" && m.slug) {
            deleteMemory(targetPath, m.slug);
            report.push(`Memory removed: ${m.slug}`);
          } else if (m.action === "supersede" && m.slug && m.type && m.title && m.description) {
            deleteMemory(targetPath, m.slug);
            const mPath = ppWithScope(undefined, m.scope);
            const result = saveMemoryTool(mPath, {
              type: m.type, title: m.title, description: m.description,
              body: m.body, keywords: m.keywords, scope: m.scope,
            }, sid);
            report.push(`Memory superseded: ${m.slug} -> ${result.slug}`);
          }
        } catch (err) {
          report.push(`Memory error (${m.action} ${m.slug ?? m.title}): ${err}`);
        }
      }
    }

    // Decisions
    if (args.decisions && args.decisions.length > 0) {
      for (const d of args.decisions) {
        try {
          if (d.action === "add" && d.title && d.decision && d.reasoning) {
            const dPath = ppWithScope(undefined, d.scope);
            const result = saveDecisionTool(dPath, {
              title: d.title, decision: d.decision, reasoning: d.reasoning,
              enforce: d.enforce, scope: d.scope,
            });
            report.push(`Decision added: ${result.id} - ${d.title}`);
          } else if (d.action === "remove" && d.id) {
            revokeDecision(targetPath, d.id, "Removed during session close by agent");
            report.push(`Decision revoked: ${d.id}`);
          } else if (d.action === "supersede" && d.id && d.title && d.decision && d.reasoning) {
            const dPath = ppWithScope(undefined, d.scope);
            const result = supersedeDecision(dPath, d.id, {
              title: d.title, slug: d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50),
              decision: d.decision, reasoning: d.reasoning,
              enforce: d.enforce ?? null, scope: d.scope,
              date: new Date().toISOString().slice(0, 10),
              source: "session" as const,
              sessionId: sid,
            });
            report.push(`Decision superseded: ${d.id} -> ${result.newDecision.id} - ${d.title}`);
          }
        } catch (err) {
          report.push(`Decision error (${d.action} ${d.id ?? d.title}): ${err}`);
        }
      }
    }

    // Safety rules
    if (args.safety_rules && args.safety_rules.length > 0) {
      for (const s of args.safety_rules) {
        try {
          if (s.action === "add") {
            updateSafetyTool(targetPath, s.rule_type, s.value, sid);
            report.push(`Safety added: ${s.rule_type} = ${s.value}`);
          } else if (s.action === "remove") {
            const { removeSafetyRule } = await import("./storage/safety.js");
            removeSafetyRule(targetPath, s.rule_type, s.value);
            report.push(`Safety removed: ${s.rule_type} = ${s.value}`);
          }
        } catch (err) {
          report.push(`Safety error (${s.action} ${s.rule_type}): ${err}`);
        }
      }
    }

    // 2. Write enriched handoff
    const { writeHandoff } = await import("./storage/plans.js");
    writeHandoff(targetPath, {
      stoppedAt: args.stopped_at,
      summary: args.summary,
      inProgress: args.in_progress,
      prs: args.prs,
      testResults: args.test_results,
      blockers: args.blockers ?? "None",
      next: args.next_steps,
      dirtyBranches: args.dirty_branches ?? "None",
      sessionId: sid,
      date: new Date().toISOString().slice(0, 10),
      source: "agent" as const,
    });

    // 3. Append worklog entry
    const { appendFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { AXME_CODE_DIR } = await import("./types.js");
    const isoDate = new Date().toISOString().slice(0, 16).replace("T", " ");
    const shortId = sid.slice(0, 8);
    const worklogEntry = `## ${isoDate} -- Session ${shortId}: ${args.stopped_at}\n\n${args.worklog_entry}\n\n`;
    try {
      appendFileSync(join(targetPath, AXME_CODE_DIR, "worklog.md"), worklogEntry);
    } catch {}

    // 4. Set agentClosed flag and spawn detached auditor.
    // The auditor runs in verify-only mode (since agentClosed=true) — its job
    // is to catch anything the agent missed. Spawning here ensures the audit
    // runs immediately on close, instead of waiting for SessionEnd hook (which
    // may never fire if Claude Code is killed) or MCP server cleanup (which
    // happens only when the server itself exits).
    //
    // IMPORTANT: we do NOT pre-set auditStatus=pending here. runSessionCleanup
    // in the worker will claim the audit itself (setting pending + started_at
    // atomically before the LLM call). If we set pending here, the worker
    // would see its OWN pending state and self-dedup as "concurrent-audit",
    // never actually running. The spawn→worker-read window is small (~1s)
    // and no other code path spawns auditors for a session whose MCP server
    // is still alive, so this gap is safe.
    const { loadSession, writeSession } = await import("./storage/sessions.js");
    const session = loadSession(targetPath, sid);
    if (session) {
      session.agentClosed = true;
      session.closedAt = new Date().toISOString();
      writeSession(targetPath, session);
    }
    // Spawn the detached audit worker. Best-effort — failure is logged but
    // does not block the close response. If spawn fails, the next MCP server
    // start will pick this up via the orphan-recovery path.
    let auditorSpawned = false;
    try {
      spawnDetachedAuditWorker(targetPath, sid);
      auditorSpawned = true;
    } catch (err) {
      process.stderr.write(`AXME finalize_close: failed to spawn auditor for ${sid}: ${err}\n`);
    }

    // 5. Build storage summary
    const summaryLines = [
      `Session ${shortId} closed.`,
      "",
      "## Storage Summary",
      ...report.length > 0 ? report.map(r => `- ${r}`) : ["- No extractions"],
      `- Handoff: written to .axme-code/plans/handoff.md`,
      `- Worklog: entry appended to .axme-code/worklog.md`,
      `- agentClosed: true`,
      `- Auditor: ${auditorSpawned ? "spawned (verify-only mode, runs in background)" : "spawn failed - will run on next session start"}`,
      "",
      "Output to the user: first the storage summary above, then the startup_text below, then the feedback request.",
      "",
      "---",
      args.startup_text,
      "---",
      "",
      "**Show this to the user at the very end:**",
      "> AXME Code is in alpha — your feedback shapes the product. If it saved you time today, consider:",
      "> - Star on GitHub: https://github.com/AxmeAI/axme-code",
      "> - Report issues or ideas: https://github.com/AxmeAI/axme-code/issues",
      "> - Share feedback: contact@axme.ai",
      "> - Support: support@axme.ai",
    ];

    return { content: [{ type: "text" as const, text: summaryLines.join("\n") }] };
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
