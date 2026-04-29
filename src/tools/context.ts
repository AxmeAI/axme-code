/**
 * Context tools - axme_context, axme_oracle, axme_decisions.
 *
 * Read project knowledge base for agent prompts.
 * Workspace-aware: merges workspace-level + project-level data when workspace_path provided.
 */

import { oracleContext, showOracle, oracleExists, loadOracleFiles } from "../storage/oracle.js";
import { decisionsContext, showDecisions, enforceableDecisionsContext, listDecisions } from "../storage/decisions.js";
import { pathExists, readSafe } from "../storage/engine.js";
import { configExists, readConfig } from "../storage/config.js";
import { isRuntimeInstalled } from "../storage/embeddings.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { AXME_CODE_DIR } from "../types.js";
import { safetyContext, loadSafetyRules } from "../storage/safety.js";
import { allMemoryContext, listMemories } from "../storage/memory.js";
import { mergeDecisions, mergeMemories, mergeSafetyRules } from "../storage/workspace-merge.js";
import { testPlanContext } from "../storage/test-plan.js";
import { plansContext, handoffContext } from "../storage/plans.js";
import { listPendingAudits } from "../storage/sessions.js";
import { detectWorkspace } from "../utils/workspace-detector.js";
import { questionsContext } from "../storage/questions.js";
import { backlogContext } from "../storage/backlog.js";

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
  const hasGit = existsSync(join(projectPath, ".git"));
  const isWorkspace = hasGit ? false : (ws.type !== "single" || (workspacePath != null && workspacePath !== projectPath));
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
 * Get full project context as array of logical sections (for pagination).
 * When workspacePath provided, merges workspace + project data.
 */
export function getFullContextSections(projectPath: string, workspacePath?: string): string[] {
  const parts: string[] = [];

  // Storage root header
  parts.push(buildStorageRootHeader(projectPath, workspacePath));

  // Not initialized check — both directory and config must exist
  const storageDirExists = pathExists(join(projectPath, AXME_CODE_DIR));
  const hasConfig = configExists(projectPath);
  if (!storageDirExists || !hasConfig) {
    // Check if setup is already running
    const setupLock = join(projectPath, AXME_CODE_DIR, "setup.lock");
    if (pathExists(setupLock)) {
      return [parts[0] + "\n\nSetup is already running. Wait for it to finish, then call axme_context again."];
    }
    return [parts[0] + "\n\nProject not initialized. FIRST tell the user: 'Initializing AXME Code knowledge base for this project. This takes 1-2 minutes on first run.' THEN run `axme-code setup --plugin` via Bash tool. Do NOT ask permission — just inform and run."];
  }

  // Safety rules (small, always inline)
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

  // Previous session handoff (small, always inline)
  const handoff = handoffContext(workspacePath ?? projectPath);
  if (handoff) parts.push(handoff);

  // Last worklog entry (just 1, not 5)
  const worklogPath = join(workspacePath ?? projectPath, AXME_CODE_DIR, "worklog.md");
  const worklogContent = readSafe(worklogPath);
  if (worklogContent.length > 20) {
    const entries = worklogContent.split(/(?=^## )/m).filter(e => e.trim());
    const last = entries.slice(-1);
    if (last.length > 0) {
      parts.push("# Last Session\n\n" + last[0]);
    }
  }

  // Test plan (small)
  const tests = testPlanContext(projectPath);
  if (tests) parts.push(tests);

  // Active plans (small)
  const plans = plansContext(projectPath);
  if (plans) parts.push(plans);

  // Backlog summary
  try {
    const bl = backlogContext(projectPath);
    if (bl) parts.push(bl);
  } catch {}

  // Open questions
  try {
    const qCtx = questionsContext(workspacePath ?? projectPath);
    if (qCtx) parts.push(qCtx);
  } catch {}

  // LLM init warning
  const decisions = listDecisions(projectPath);
  const llmDecisions = decisions.filter(d => d.source === "init-scan");
  if (llmDecisions.length === 0 && oracleExists(projectPath)) {
    const files = loadOracleFiles(projectPath);
    const oracleIsMinimal = files && files.stack.length < 200 && !files.patterns.includes("CLAUDE.md");
    if (oracleIsMinimal) {
      parts.push("**WARNING:** This project was initialized with deterministic scan only (no LLM). Run `axme-code setup " + projectPath + "` for deep LLM scan.");
    }
  }

  // Pending audits warning
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
      `${allPending.length} previous session audit(s) are still running.`,
      ...allPending.map(p => {
        const startedAgo = Math.round((Date.now() - new Date(p.startedAt).getTime()) / 1000);
        return `- session ${p.sessionId.slice(0, 8)} at ${p.location} level, started ${startedAgo}s ago, phase=${p.phase}`;
      }),
      "",
      "**Action**: tell the user, then either wait and re-run `axme_context`, or add a TODO to re-check periodically.",
    ];
    parts.push(lines.join("\n"));
  }

  // Context-loading branch: full mode (load everything) vs search mode
  // (catalog only + on-demand fetch via axme_get_*/axme_search_kb).
  const config = readConfig(projectPath);
  const totalKbSize = listMemoriesMerged(projectPath, workspacePath).length
    + listDecisionsMerged(projectPath, workspacePath).length;

  if (config.contextMode === "search") {
    parts.push(buildSearchModeCatalog(projectPath, workspacePath));
    parts.push(buildSearchModeInstructions(isRuntimeInstalled()));
  } else {
    // Full mode (default) — keep existing parallel-load instruction.
    parts.push([
      "## Load Full Knowledge Base",
      "",
      "Call these three tools **in parallel** now to load the complete knowledge base:",
      "1. `axme_oracle` - project stack, structure, patterns, glossary",
      "2. `axme_decisions` - architectural decisions with enforce levels",
      "3. `axme_memories` - feedback and validated patterns",
      "",
      "**IMPORTANT**: if any tool output is truncated or saved to a file, use the Read tool to read the full file content into your context. Do not proceed with partial data.",
    ].join("\n"));

    // Soft hint for users still on full mode whose KB has grown past the
    // point where loading every body becomes wasteful. Threshold (100) is a
    // recommendation, not a cutoff — full mode keeps working at any size.
    if (totalKbSize > 100) {
      parts.push([
        "## Knowledge base size hint",
        "",
        `Your KB has ${totalKbSize} entries (memories + decisions). For KBs >100 entries,`,
        "switching to **search mode** loads only a catalog at session start and fetches",
        "full bodies on demand via `axme_get_memory(slug)` / `axme_get_decision(id)` /",
        "`axme_search_kb(query)`. Cuts startup tokens by ~10x. To enable:",
        "",
        "```bash",
        "axme-code config set context.mode search",
        "```",
        "",
        "(One-time install of ~100MB transformers.js + ~30MB MiniLM model. Falls back to",
        "full mode if install fails. Run `axme-code config set context.mode full` to revert.)",
      ].join("\n"));
    }
  }

  return parts;
}

/** Memories merged across workspace+project for KB-size accounting. */
function listMemoriesMerged(projectPath: string, workspacePath?: string) {
  return workspacePath && workspacePath !== projectPath
    ? mergeMemories(listMemories(workspacePath), listMemories(projectPath))
    : listMemories(projectPath);
}

/** Decisions merged across workspace+project for KB-size accounting. */
function listDecisionsMerged(projectPath: string, workspacePath?: string) {
  return workspacePath && workspacePath !== projectPath
    ? mergeDecisions(listDecisions(workspacePath), listDecisions(projectPath))
    : listDecisions(projectPath);
}

/**
 * Render the search-mode catalog: title + 1-line description for every
 * memory and decision, prefixed with [type] / [enforce] so the agent can
 * prioritize what to fetch in full.
 *
 * No bodies. No keywords. Compact. Typically 5-10x smaller than full mode.
 */
function buildSearchModeCatalog(projectPath: string, workspacePath?: string): string {
  const memories = listMemoriesMerged(projectPath, workspacePath);
  const decisions = listDecisionsMerged(projectPath, workspacePath);
  const lines: string[] = [
    "## Knowledge Base Catalog (search mode)",
    "",
    `${decisions.length} decision(s), ${memories.length} memory(ies). Bodies are NOT loaded.`,
    "",
  ];
  if (decisions.length > 0) {
    lines.push("### Decisions");
    lines.push("");
    for (const d of decisions) {
      const enforce = d.enforce ?? "info";
      const desc = d.decision ? d.decision.replace(/\s+/g, " ").slice(0, 200) : "";
      lines.push(`- [${enforce}] **${d.id}** — ${d.title}${desc ? ` — ${desc}` : ""}`);
    }
    lines.push("");
  }
  if (memories.length > 0) {
    lines.push("### Memories");
    lines.push("");
    for (const m of memories) {
      const desc = m.description ? m.description.replace(/\s+/g, " ").slice(0, 200) : "";
      lines.push(`- [${m.type}] **${m.slug}** — ${m.title}${desc ? ` — ${desc}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Instructions agent must follow in search mode: scan the catalog, fetch
 * bodies via the three new MCP tools, never write code from titles alone.
 */
function buildSearchModeInstructions(runtimeInstalled: boolean): string {
  const searchAvailable = runtimeInstalled
    ? "- `axme_search_kb(query, type?, k?)` — semantic search across both"
    : "- `axme_search_kb(query, ...)` — currently UNAVAILABLE (transformers runtime not installed; falls back to a hint message)";
  return [
    "## Search mode active — bodies fetched on demand",
    "",
    "You have a catalog of every memory and decision above (titles + descriptions only).",
    "Bodies are NOT loaded. Token cost at session start is ~10x lower than full mode.",
    "",
    "**MUST**: scan the catalog before generating code. If a title is relevant to your task,",
    "fetch the full body **before** writing.",
    "",
    "- `axme_get_memory(slug)` — full body of one memory",
    "- `axme_get_decision(id_or_slug)` — full body of one decision",
    searchAvailable,
    "",
    runtimeInstalled
      ? "Use `axme_search_kb` for fuzzy lookups (\"how did we handle X?\"). Use `axme_get_*` when you already know the slug from the catalog."
      : "Without the runtime, navigate the catalog above by topic and fetch bodies via `axme_get_*`. To enable semantic search: `axme-code config set context.mode search` (re-runs install).",
  ].join("\n");
}

/** Legacy joined output (for backward compat where needed). */
export function getFullContext(projectPath: string, workspacePath?: string): string {
  return getFullContextSections(projectPath, workspacePath).join("\n\n");
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
