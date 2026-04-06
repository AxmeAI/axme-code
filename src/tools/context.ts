/**
 * Context tools - axme_context, axme_oracle, axme_decisions.
 *
 * Read project knowledge base for agent prompts.
 * Workspace-aware: merges workspace-level + project-level data when workspace_path provided.
 */

import { oracleContext, showOracle, oracleExists, loadOracleFiles } from "../storage/oracle.js";
import { decisionsContext, showDecisions, enforceableDecisionsContext, listDecisions } from "../storage/decisions.js";
import { pathExists, readSafe } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";
import { safetyContext, loadSafetyRules } from "../storage/safety.js";
import { allMemoryContext, listMemories } from "../storage/memory.js";
import { mergeDecisions, mergeMemories, mergeSafetyRules } from "../storage/workspace-merge.js";
import { testPlanContext } from "../storage/test-plan.js";
import { plansContext, handoffContext } from "../storage/plans.js";
import { listPendingAudits } from "../storage/sessions.js";
import { detectWorkspace } from "../utils/workspace-detector.js";
import { questionsContext } from "../storage/questions.js";

/**
 * Build the authoritative "Storage root" header that is prepended to every
 * axme_context output. This is the single source of truth for agents on
 * where the .axme-code/ files for the current session physically live.
 *
 * Why this exists: in a multi-repo workspace, the workspace root has its
 * own .axme-code/ and each child repo also has its own .axme-code/. Agents
 * that do `ls .axme-code/sessions/` relative to their cwd get different
 * answers depending on which subdirectory they cd'd into, and silently
 * read the wrong dataset. Surfacing the absolute path at the top of the
 * context output (and instructing the agent to use it for ALL direct
 * .axme-code/ inspection) closes that ambiguity.
 */
function buildStorageRootHeader(projectPath: string, workspacePath?: string): string {
  const ws = detectWorkspace(projectPath);
  const isWorkspace = ws.type !== "single" || (workspacePath != null && workspacePath !== projectPath);
  const sessionType = isWorkspace ? "workspace (multi-repo)" : "single-repo";
  const storageRoot = join(projectPath, AXME_CODE_DIR);
  const lines = [
    "# AXME Storage Root",
    "",
    `- Session origin: ${projectPath}`,
    `- Session type: ${sessionType}`,
    `- Storage root: ${storageRoot}`,
    `- Sessions dir: ${storageRoot}/sessions`,
    `- Audit logs dir: ${storageRoot}/audit-logs`,
    `- Audit worker logs: ${storageRoot}/audit-worker-logs`,
    "",
    "**CRITICAL**: For any direct inspection of .axme-code/ files via Bash (ls, cat, grep, find, etc.), use ABSOLUTE paths rooted at the Storage root above. Do NOT use relative paths from your cwd — in a multi-repo workspace, your cwd may point into a child repo that has its own separate .axme-code/ storage, and you will silently read the wrong dataset. The Storage root above is the only path that corresponds to this session's live data.",
    "",
    "**If you need to verify where an older session came from**: every session's `meta.json` now contains an `origin` field with the absolute path of the directory where the MCP server was running when the session was created. Read that field — it tells you which .axme-code/ storage that specific session belongs to. Use this whenever you pick up a session file directly instead of going through axme_context, or when cross-checking sessions from past runs.",
  ];
  return lines.join("\n");
}

/**
 * Get full project context (oracle + decisions + safety + memory + test plan + plans).
 * When workspacePath provided, merges workspace + project data.
 */
export function getFullContext(projectPath: string, workspacePath?: string): string {
  const parts: string[] = [];

  // Storage root header — always first so the agent sees it before anything
  // else. Tells the agent the absolute path to use for direct file inspection.
  parts.push(buildStorageRootHeader(projectPath, workspacePath));

  // Oracle
  const oracle = oracleContext(projectPath);
  if (oracle) parts.push("# Project Oracle\n\n" + oracle);
  if (workspacePath && workspacePath !== projectPath) {
    const wsOracle = oracleContext(workspacePath);
    if (wsOracle) parts.push("# Workspace Oracle\n\n" + wsOracle);
  }

  // Decisions (merged if workspace)
  if (workspacePath && workspacePath !== projectPath) {
    const wsDecisions = listDecisions(workspacePath);
    const projDecisions = listDecisions(projectPath);
    const merged = mergeDecisions(wsDecisions, projDecisions);
    if (merged.length > 0) {
      const lines = merged.map(d => `- **${d.id}: ${d.title}** [${d.enforce ?? "info"}] - ${d.decision}`);
      parts.push(`## Project Decisions\n${lines.join("\n")}`);
    }
  } else {
    const decisions = decisionsContext(projectPath);
    if (decisions) parts.push(decisions);
  }

  // Safety (merged if workspace)
  if (workspacePath && workspacePath !== projectPath) {
    const wsRules = loadSafetyRules(workspacePath);
    const projRules = loadSafetyRules(projectPath);
    const merged = mergeSafetyRules(wsRules, projRules);
    const safeParts: string[] = ["## Safety Rules"];
    if (merged.git.protectedBranches.length > 0) safeParts.push(`- Protected branches: ${merged.git.protectedBranches.join(", ")}`);
    if (!merged.git.allowForcePush) safeParts.push("- Force push: DENIED");
    if (merged.bash.deniedPrefixes.length > 0) safeParts.push(`- Denied commands: ${merged.bash.deniedPrefixes.slice(0, 8).join(", ")}`);
    if (safeParts.length > 1) parts.push(safeParts.join("\n"));
  } else {
    const safety = safetyContext(projectPath);
    if (safety) parts.push(safety);
  }

  // Memory (merged if workspace)
  if (workspacePath && workspacePath !== projectPath) {
    const wsMemories = listMemories(workspacePath);
    const projMemories = listMemories(projectPath);
    const merged = mergeMemories(wsMemories, projMemories);
    if (merged.length > 0) {
      const feedbacks = merged.filter(m => m.type === "feedback");
      const patterns = merged.filter(m => m.type === "pattern");
      const memParts: string[] = ["## Project Memories"];
      if (feedbacks.length > 0) { memParts.push(`\n### Feedback (${feedbacks.length}):`); for (const m of feedbacks) memParts.push(`- **${m.title}**: ${m.description}`); }
      if (patterns.length > 0) { memParts.push(`\n### Patterns (${patterns.length}):`); for (const m of patterns) memParts.push(`- **${m.title}**: ${m.description}`); }
      parts.push(memParts.join("\n"));
    }
  } else {
    const memory = allMemoryContext(projectPath);
    if (memory) parts.push(memory);
  }

  // Test plan
  const tests = testPlanContext(projectPath);
  if (tests) parts.push(tests);

  // Active plans
  const plans = plansContext(projectPath);
  if (plans) parts.push(plans);

  // Previous session handoff - shows next session what was done and what to do next
  const handoff = handoffContext(workspacePath ?? projectPath);
  if (handoff) parts.push(handoff);

  // "parts" always has at least the Storage root header — so detect
  // "not initialized" by checking absence of any real content modules.
  const storageDirExists = pathExists(join(projectPath, AXME_CODE_DIR));
  if (!storageDirExists) {
    return parts[0] + "\n\nProject not initialized. Ask the user to run 'axme-code setup' in terminal.";
  }

  // Check if LLM init was done (LLM-scanned oracle has rich content, deterministic has minimal)
  const decisions = listDecisions(projectPath);
  const llmDecisions = decisions.filter(d => d.source === "init-scan");
  if (llmDecisions.length === 0 && oracleExists(projectPath)) {
    const files = loadOracleFiles(projectPath);
    const oracleIsMinimal = files && files.stack.length < 200 && !files.patterns.includes("CLAUDE.md");
    if (oracleIsMinimal) {
      parts.push("\n---\n**WARNING:** This project was initialized with deterministic scan only (no LLM). Oracle and decisions may be incomplete. Ask the user to run `axme-code setup " + projectPath + "` in terminal for deep LLM scan.");
    }
  }

  // Pending audits warning: check BOTH the current project AND the workspace
  // root (if different), so the agent sees audits running at either level.
  // listPendingAudits derives state from SessionMeta.auditStatus and already
  // filters out stale "pending" entries older than AUDIT_STALE_TIMEOUT_MS
  // (crashed auditors), so the returned list represents genuinely in-flight
  // audits only.
  const pendingProject = listPendingAudits(projectPath);
  const pendingWorkspace = workspacePath && workspacePath !== projectPath
    ? listPendingAudits(workspacePath)
    : [];
  const allPending = [
    ...pendingProject.map(p => ({ ...p, location: "project" as const })),
    ...pendingWorkspace.map(p => ({ ...p, location: "workspace" as const })),
  ];
  if (allPending.length > 0) {
    const lines = [
      "## ⚠️ Pending audits (knowledge base may be incomplete)",
      "",
      `${allPending.length} previous session audit(s) are still running. Their extracted memories, decisions, and handoff notes are NOT yet reflected in the knowledge base above.`,
      "",
      "Pending:",
      ...allPending.map(p => {
        const startedAgo = Math.round((Date.now() - new Date(p.startedAt).getTime()) / 1000);
        return `- session ${p.sessionId.slice(0, 8)} at ${p.location} level, started ${startedAgo}s ago, phase=${p.phase}`;
      }),
      "",
      "**Agent action required**: tell the user about the pending audit(s) and offer two options:",
      "  1. Wait a few minutes and re-run `axme_context` to pick up the fresh knowledge before proceeding.",
      "  2. Add a TODO to check back in N minutes and continue in parallel until then, re-checking `axme_context` periodically until the pending list is empty.",
      "Keep the TODO open until all pending audits are gone.",
    ];
    parts.push(lines.join("\n"));
  }

  // Open questions: show any pending questions from previous sessions/audits
  try {
    const qCtx = questionsContext(workspacePath ?? projectPath);
    if (qCtx) parts.push(qCtx);
  } catch {}

  // Recent worklog: show last few narrative session summaries so the agent
  // knows what happened in recent sessions without reading the full history.
  const worklogPath = join(workspacePath ?? projectPath, AXME_CODE_DIR, "worklog.md");
  const worklogContent = readSafe(worklogPath);
  if (worklogContent.length > 20) {
    // Extract last 5 entries (each starts with "## ")
    const entries = worklogContent.split(/(?=^## )/m).filter(e => e.trim());
    const recent = entries.slice(-5);
    if (recent.length > 0) {
      parts.push("# Recent Session History\n\n" + recent.join("\n"));
    }
  }

  return parts.join("\n\n");
}

export function getOracle(projectPath: string): string {
  if (!oracleExists(projectPath)) return "Oracle not initialized. Run axme_init first.";
  return showOracle(projectPath);
}

export function getDecisions(projectPath: string): string {
  return showDecisions(projectPath);
}

export function getEnforceableRules(projectPath: string): string {
  return enforceableDecisionsContext(projectPath);
}

/**
 * Build dedup context for session close checklist.
 * Lists existing memories, decisions, and safety rules so the agent
 * can avoid saving duplicates during the close extraction.
 */
export function getCloseContext(projectPath: string, workspacePath?: string): string {
  const parts: string[] = [];

  // Workspace projects list (for scope targeting)
  const ws = detectWorkspace(projectPath);
  if (ws.type !== "single") {
    parts.push("### Workspace Projects (valid scope targets)");
    for (const p of ws.projects) {
      parts.push(`- \`${p.name}\` (${p.path})`);
    }
    parts.push("");
  }

  // Merge workspace + project data if applicable
  const hasWorkspace = workspacePath && workspacePath !== projectPath;

  // Existing memories
  const memories = hasWorkspace
    ? mergeMemories(listMemories(workspacePath), listMemories(projectPath))
    : listMemories(projectPath);
  if (memories.length > 0) {
    parts.push("### Existing Memories (do NOT re-save these)");
    for (const m of memories) {
      parts.push(`- [${m.type}] \`${m.slug}\`: ${m.title}`);
    }
    parts.push("");
  }

  // Existing decisions
  const decisions = hasWorkspace
    ? mergeDecisions(listDecisions(workspacePath), listDecisions(projectPath))
    : listDecisions(projectPath);
  if (decisions.length > 0) {
    parts.push("### Existing Decisions (do NOT re-save same topics)");
    for (const d of decisions) {
      parts.push(`- ${d.id}: ${d.title} [${d.enforce ?? "info"}]`);
    }
    parts.push("");
  }

  // Existing safety rules
  const rules = hasWorkspace
    ? mergeSafetyRules(loadSafetyRules(workspacePath), loadSafetyRules(projectPath))
    : loadSafetyRules(projectPath);
  const safetyLines: string[] = [];
  if (rules.git.protectedBranches.length > 0)
    safetyLines.push(`Protected branches: ${rules.git.protectedBranches.join(", ")}`);
  if (rules.bash.deniedPrefixes.length > 0)
    safetyLines.push(`Denied prefixes (${rules.bash.deniedPrefixes.length}): ${rules.bash.deniedPrefixes.slice(0, 15).join(", ")}...`);
  if (rules.bash.deniedCommands && rules.bash.deniedCommands.length > 0)
    safetyLines.push(`Denied commands (${rules.bash.deniedCommands.length}): ${rules.bash.deniedCommands.join(", ")}`);
  if (safetyLines.length > 0) {
    parts.push("### Existing Safety Rules (do NOT re-add)");
    parts.push(safetyLines.join("\n"));
    parts.push("");
  }

  return parts.join("\n");
}
