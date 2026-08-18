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
import { runKbDoctor, countOverlong } from "../storage/kb-doctor.js";
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
    `- Sessions dir: ${join(storageRoot, "sessions")}`,
    `- Audit logs dir: ${join(storageRoot, "audit-logs")}`,
    `- Audit worker logs: ${join(storageRoot, "audit-worker-logs")}`,
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
      return [parts[0] + "\n\nSetup is already running (`.axme-code/setup.lock` is present). Wait for it to finish, then call axme_context again. If the user says no setup is running, the lock is a leftover from an interrupted setup — it self-expires 15 minutes after it was written, or the user can re-run setup with `--force`."];
    }
    // Canonical not-initialized flow — keep in sync with the PROJECT SETUP
    // REQUIRED block in server.ts instructions and the CLAUDE.md section
    // written by `check-init` (cli.ts). One story everywhere: offer the user
    // setup, on consent EXECUTE the inline MCP-tool-call sequence. Never
    // tell the agent to run `axme-code` via Bash — for plugin installs the
    // binary is not on PATH and the call just fails.
    return [parts[0] + "\n\nProject not initialized — `.axme-code/` storage is missing (or has no config). Offer the user AXME setup; on consent, EXECUTE the inline setup flow from the server instructions (the \"PROJECT SETUP REQUIRED\" block: a sequence of axme_save_decision / axme_save_memory / axme_update_safety / axme_save_oracle tool calls — the first save call auto-bootstraps `.axme-code/`). Do NOT run `axme-code setup` via the Bash tool — on plugin installs the binary is not on PATH. The user can alternatively run the deeper LLM scan themselves: `AXME: Setup` from the Command Palette (Cursor extension) or `axme-code setup` in a terminal (CLI installs)."];
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
      parts.push("**WARNING:** This project was initialized with deterministic scan only (no LLM). Tell the user to re-run `axme-code setup " + projectPath + "` for a deep LLM scan. **Do not run it yourself** — initialization is the user's job.");
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

  // Storage self-repair. Runs before the catalog is rendered so a session
  // never reads a base that still has files it cannot see. Only mechanical,
  // reversible repairs happen here (rename a file to a valid slug, drop a
  // leaked XML frame) — nothing is deleted, nothing is rewritten for style.
  const repair = repairStorageOnStart(projectPath);
  if (repair) parts.push(repair);

  // Context-loading branch: full mode (load everything) vs search mode
  // (catalog only + on-demand fetch via axme_get_*/axme_search_kb).
  const config = readConfig(projectPath);
  const memCount = listMemoriesMerged(projectPath, workspacePath).length;
  const decCount = listDecisionsMerged(projectPath, workspacePath).length;
  const totalKbSize = memCount + decCount;

  const hygiene = buildHygieneLine(projectPath, memCount, decCount, config);
  if (hygiene) parts.push(hygiene);

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

    // Directive hint for users still on full mode whose KB has grown past
    // the point where loading every body becomes wasteful. Threshold (100)
    // is a recommendation, not a cutoff — full mode keeps working at any
    // size. Worded as a MUST so the agent reliably surfaces the option to
    // the user instead of silently absorbing the warning.
    if (totalKbSize > 100) {
      parts.push([
        "## ⚠️ Knowledge base size — action required",
        "",
        `This project has **${totalKbSize} KB entries** (memories + decisions). Loading every body at`,
        "session start is wasteful at this size — both in tokens and in your time waiting for the",
        "context to load.",
        "",
        "**MUST** tell the user, in your first response:",
        "",
        `> Your AXME knowledge base has ${totalKbSize} entries. Search mode would cut session-start`,
        "> tokens by ~10x — the agent gets a catalog (titles + 1-line summaries) at start and fetches",
        "> full bodies on demand via axme_search_kb / axme_get_memory / axme_get_decision.",
        "> ",
        "> Switching is opt-in. The CLI command is:",
        "> ",
        "> ```bash",
        "> axme-code config set context.mode search",
        "> ```",
        "> ",
        "> It installs ~100 MB of local embedding runtime (transformers.js + MiniLM model — runs on",
        "> your CPU, no API calls, no token cost). On install failure the config rolls back to full",
        "> automatically. Revert any time with `axme-code config set context.mode full`.",
        "> ",
        "> Want me to run the command for you now, or will you run it yourself in your terminal?",
        "",
        "Then **WAIT** for the user's decision before continuing with the original task:",
        "",
        "- If the user says \"run it\" / \"yes\" / \"go ahead\" → execute the command via Bash and proceed.",
        "- If the user says \"I'll do it\" / \"later\" / \"skip\" → do NOT run it; continue the task in full mode.",
        "- If the user is silent or asks an unrelated question → continue in full mode; do not nag again",
        "  this session.",
        "",
        "Do NOT switch the mode without explicit user confirmation. Do NOT nag again in the same",
        "session if the user declines or moves on.",
      ].join("\n"));
    }
  }

  return parts;
}

/**
 * Repair mechanical storage defects at session start, returning a one-line
 * report when anything was touched (null when the base was clean).
 *
 * Runs on every axme_context call because the defects it fixes are actively
 * destructive: a memory saved under an empty slug lands as bare `.md`, and
 * the NEXT such memory overwrites it. Waiting for the user to run a repair
 * command means the second write has already destroyed the first. The pass
 * is idempotent and costs a directory walk, so paying it every session is
 * cheaper than losing one entry.
 *
 * Deliberately silent about clean bases: a "nothing was wrong" line every
 * session is noise the agent learns to skip, which would also make it skip
 * the line that matters.
 */
function repairStorageOnStart(projectPath: string): string | null {
  let report;
  try {
    report = runKbDoctor(projectPath, { fix: true });
  } catch {
    // Never let a repair failure block context loading — a session with an
    // unrepaired base still works; a session with no context does not.
    return null;
  }
  if (report.fixed.length === 0) return null;

  const byKind = new Map<string, number>();
  for (const d of report.fixed) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
  const summary = [...byKind.entries()].map(([k, n]) => `${k}: ${n}`).join(", ");

  const lines = [
    "## Storage repaired at session start",
    "",
    `${report.fixed.length} mechanical defect(s) fixed automatically (${summary}).`,
    "",
    ...report.fixed.slice(0, 5).map(d => `- ${d.file}\n  ${d.detail}`),
  ];
  if (report.fixed.length > 5) lines.push(`- … and ${report.fixed.length - 5} more`);
  lines.push(
    "",
    "Nothing was deleted — files were renamed to valid slugs and/or leaked tool-call markup was",
    "stripped. Mention this to the user in your first response: entries that previously shared a",
    "filename may have been overwriting each other before this repair.",
  );
  return lines.join("\n");
}

/**
 * One block about knowledge-base size and format, emitted only when the base
 * has actually crossed a threshold worth acting on.
 *
 * Two distinct problems get reported here, and they have different fixes:
 *
 *  - too many entries  → compaction (audit-kb), because the cost is the count;
 *  - overlong entries  → reformatting, because the cost is that each entry
 *    pays for detail nobody reads at session start while ALSO being cut off
 *    in the catalog. That combination is the worst of both modes: full mode
 *    pays for everything, search mode shows less than half of it.
 */
function buildHygieneLine(
  projectPath: string, memCount: number, decCount: number,
  config: { catalogExcerptChars: number; kbSizeWarnThreshold: number; contextMode: string },
): string | null {
  const total = memCount + decCount;
  let overlong;
  try {
    overlong = countOverlong(projectPath);
  } catch {
    overlong = { memories: 0, decisions: 0, total: 0, excerptChars: config.catalogExcerptChars };
  }

  const sizeProblem = total >= config.kbSizeWarnThreshold;
  // A tenth of the base overrunning is where the catalog stops being a
  // faithful summary; below that it is a rounding error not worth a warning.
  const formatProblem = overlong.total > 0 && overlong.total >= Math.max(5, Math.round(total * 0.1));
  if (!sizeProblem && !formatProblem) return null;

  const lines = ["## Knowledge base hygiene", ""];

  if (sizeProblem) {
    lines.push(
      `This base holds **${memCount} memories + ${decCount} decisions = ${total} entries** ` +
      `(warn threshold ${config.kbSizeWarnThreshold}, set via \`catalog.size_warn\`).`,
      "",
      "Tell the user once, in your first response, that a compaction pass is due:",
      "",
      "> ```bash",
      "> axme-code audit-kb .  --dry-run   # preview: what would be compacted, merged, archived",
      "> axme-code audit-kb .              # apply (takes a backup first)",
      "> ```",
      "",
    );
  }

  if (formatProblem) {
    lines.push(
      `**${overlong.total} entries** (${overlong.memories} memories, ${overlong.decisions} decisions) have a ` +
      `loaded layer longer than the ${overlong.excerptChars}-char catalog budget.`,
      "",
      "These entries are paying twice: their full text is loaded in `full` mode, and in `search` mode the",
      "catalog shows only the first part of them. Entries written to the budget cost the same in both modes",
      "and lose nothing — which is what makes the two modes interchangeable.",
      "",
      "`axme-code kb-doctor .` lists them; `axme-code audit-kb .` rewrites them (rule in the description,",
      "numbers and paths moved into the deferred body).",
      "",
    );
  }

  lines.push(
    "**When YOU save entries this session**: description (memory) / decision (decision) must be the rule",
    `plus one concrete fact, at most ${overlong.excerptChars} chars — that field is loaded into EVERY future`,
    "session. Put measurements, file paths, line numbers and command output in `body` / `reasoning`, which",
    "cost nothing at session start and are returned in full by axme_get_memory / axme_get_decision.",
  );
  return lines.join("\n");
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
  const limit = readConfig(projectPath).catalogExcerptChars;

  const decisionLines = decisions.map(d => renderDecisionCatalogLine(d, limit));
  const memoryLines = memories.map(m => renderMemoryCatalogLine(m, limit));
  const truncated = [...decisionLines, ...memoryLines].filter(isTruncatedLine).length;
  const total = decisions.length + memories.length;

  const lines: string[] = [
    "## Knowledge Base Catalog (search mode)",
    "",
    `${decisions.length} decision(s), ${memories.length} memory(ies). Bodies are NOT loaded.`,
    "",
    ...catalogLegend(limit, truncated, total),
  ];
  if (decisionLines.length > 0) {
    lines.push("### Decisions", "", ...decisionLines, "");
  }
  if (memoryLines.length > 0) {
    lines.push("### Memories", "", ...memoryLines, "");
  }
  return lines.join("\n");
}

/** A rendered catalog line whose excerpt was cut. */
function isTruncatedLine(line: string): boolean {
  return line.endsWith("…[TRUNCATED]");
}

/**
 * Trim one description to the catalog budget, marking the cut.
 *
 * The marker is the point. A silently truncated line is indistinguishable
 * from a complete one, so an agent reading the catalog cannot tell which
 * entries it already understands and which it is only seeing the head of —
 * and in practice it fetches neither. With the marker, "ends in …" is a
 * mechanical signal to call axme_get_*, and its absence is a guarantee
 * that the entry is complete as shown.
 */
function excerpt(text: string | undefined, limit: number): { text: string; truncated: boolean } {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return { text: flat, truncated: false };
  // Cut on a word boundary when one is close, so the tail is readable.
  const hard = flat.slice(0, limit);
  const lastSpace = hard.lastIndexOf(" ");
  const cut = lastSpace > limit - 20 ? hard.slice(0, lastSpace) : hard;
  return { text: cut, truncated: true };
}

function renderDecisionCatalogLine(
  d: { id: string; title: string; enforce?: string | null; decision?: string }, limit: number,
): string {
  const enforce = d.enforce ?? "info";
  const { text, truncated } = excerpt(d.decision, limit);
  const tail = text ? ` — ${text}${truncated ? " …[TRUNCATED]" : ""}` : "";
  return `- [${enforce}] **${d.id}** — ${d.title}${tail}`;
}

function renderMemoryCatalogLine(
  m: { slug: string; title: string; type: string; description?: string }, limit: number,
): string {
  const { text, truncated } = excerpt(m.description, limit);
  const tail = text ? ` — ${text}${truncated ? " …[TRUNCATED]" : ""}` : "";
  return `- [${m.type}] **${m.slug}** — ${m.title}${tail}`;
}

/**
 * Header explaining the [TRUNCATED] marker and what the agent owes each kind
 * of line. Rendered above every catalog so the contract travels with the
 * data instead of living only in the mode instructions further down.
 */
function catalogLegend(limit: number, truncatedCount: number, total: number): string[] {
  if (total === 0) return [];
  if (truncatedCount === 0) {
    return [
      `Every entry below is COMPLETE as shown (all fit the ${limit}-char catalog budget).`,
      "No axme_get_memory / axme_get_decision call is needed to understand any of them.",
      "",
    ];
  }
  return [
    `Entries are cut at ${limit} chars. **${truncatedCount} of ${total}** end in \`…[TRUNCATED]\` —`,
    "for those you are seeing only the beginning, and you MUST call `axme_get_memory(slug)` /",
    "`axme_get_decision(id)` before acting on them. Lines without the marker are complete as shown.",
    "",
  ];
}

/**
 * Build the catalog string returned by `axme_decisions` in search mode.
 * Lists all decisions (project + workspace-merged when applicable) as
 * `[enforce] D-NNN — title — short description (≤200 chars)`. No bodies.
 *
 * Format intentionally matches page-2 of `axme_context` so the agent sees
 * the same shape regardless of which entry point loaded the data.
 */
export function buildDecisionsCatalogString(projectPath: string, workspacePath?: string): string {
  const decisions = listDecisionsMerged(projectPath, workspacePath);
  const limit = readConfig(projectPath).catalogExcerptChars;
  const rendered = decisions.map(d => renderDecisionCatalogLine(d, limit));
  const lines: string[] = [
    "## Decisions Catalog (search mode)",
    "",
    `${decisions.length} decision(s). Bodies NOT loaded — fetch via axme_get_decision(id_or_slug) or axme_search_kb(query).`,
    "",
    ...catalogLegend(limit, rendered.filter(isTruncatedLine).length, decisions.length),
  ];
  if (decisions.length === 0) {
    lines.push("No decisions recorded.");
    return lines.join("\n");
  }
  lines.push(...rendered);
  return lines.join("\n");
}

/**
 * Build the catalog string returned by `axme_memories` in search mode.
 * Same shape as decisions catalog but keyed by slug + memory type.
 */
export function buildMemoriesCatalogString(projectPath: string, workspacePath?: string): string {
  const memories = listMemoriesMerged(projectPath, workspacePath);
  const limit = readConfig(projectPath).catalogExcerptChars;
  const rendered = memories.map(m => renderMemoryCatalogLine(m, limit));
  const lines: string[] = [
    "## Memories Catalog (search mode)",
    "",
    `${memories.length} memory(ies). Bodies NOT loaded — fetch via axme_get_memory(slug) or axme_search_kb(query).`,
    "",
    ...catalogLegend(limit, rendered.filter(isTruncatedLine).length, memories.length),
  ];
  if (memories.length === 0) {
    lines.push("No memories recorded.");
    return lines.join("\n");
  }
  lines.push(...rendered);
  return lines.join("\n");
}

/**
 * Instructions agent must follow in search mode: scan the catalog, fetch
 * bodies via the three new MCP tools, never write code from titles alone.
 *
 * The "Active KB usage" block lists concrete trigger predicates so the
 * agent calls search proactively instead of relying on memory of past
 * sessions. Triggers are phrased as situations the agent can recognize
 * in the user's task text ("how did we ...", file/area names, library
 * names) — no enforcement, but explicit MUSTs.
 */
function buildSearchModeInstructions(runtimeInstalled: boolean): string {
  const searchAvailable = runtimeInstalled
    ? "- `axme_search_kb(query, type?, k?)` — semantic search across both"
    : "- `axme_search_kb(query, ...)` — currently UNAVAILABLE (transformers runtime not installed; falls back to a hint message)";
  const lines = [
    "## Search mode active",
    "",
    "The catalog above is the knowledge base, not an index of it. Every entry that fits the catalog",
    "budget is shown COMPLETE — for those there is nothing further to fetch, and re-fetching them",
    "wastes a tool call. Entries marked `…[TRUNCATED]` are the exception: you have seen only their",
    "opening, and the rest is one call away.",
    "",
    "- `axme_get_memory(slug)` — full record of one memory (description + the deferred `## Details`)",
    "- `axme_get_decision(id_or_slug)` — full record of one decision (body + `## Reasoning`)",
    searchAvailable,
    "",
    "## When to fetch",
    "",
    "**MUST** fetch before acting when any of these holds:",
    "",
    "- The catalog line is marked `…[TRUNCATED]` and its topic touches your task. The visible part is",
    "  the rule; the hidden part is usually the numbers, paths and edge cases you need to apply it.",
    "- You are about to write or change code touching a subsystem some entry names.",
    "- You are about to propose a fix for a bug — check `feedback` entries for the same failure first.",
    "- You are about to save a new memory or decision — check whether one already covers it, and extend",
    "  that one instead of adding a near-duplicate.",
    "",
    "**MUST** call `axme_search_kb` (not just scan the catalog) when:",
    "",
    "- The user asks \"how did we…\", \"why did we…\", \"что мы решили про…\", \"why is X this way?\"",
    "- The user names a library, platform, tool, or error message.",
    "- You are about to make an architectural recommendation — search the subsystem for prior decisions",
    "  so you neither contradict nor duplicate one.",
    "",
    "**Do NOT** fetch an entry whose catalog line is already complete just to be thorough. The catalog",
    "line and the record's loaded layer are the same text; the extra call returns the deferred body,",
    "which matters only when you need the specifics it holds.",
    "",
    "Skipping this has caused real regressions here (force-pushing main, missing the #!axme gate suffix,",
    "duplicating an existing decision). Catalog scanning is free; semantic search is sub-second and runs",
    "locally on CPU at zero token cost.",
  ];
  lines.push("");
  lines.push(runtimeInstalled
    ? "Use `axme_search_kb` for fuzzy lookups. Use `axme_get_*` when you already know the slug from the catalog."
    : "Runtime not installed: navigate the catalog above by topic and fetch bodies via `axme_get_*`. To enable semantic search: `axme-code config set context.mode search` (re-runs install).");
  return lines.join("\n");
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
