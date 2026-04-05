/**
 * Context tools - axme_context, axme_oracle, axme_decisions.
 *
 * Read project knowledge base for agent prompts.
 * Workspace-aware: merges workspace-level + project-level data when workspace_path provided.
 */

import { oracleContext, showOracle, oracleExists, loadOracleFiles } from "../storage/oracle.js";
import { decisionsContext, showDecisions, enforceableDecisionsContext, listDecisions } from "../storage/decisions.js";
import { pathExists } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";
import { safetyContext, loadSafetyRules } from "../storage/safety.js";
import { allMemoryContext, listMemories } from "../storage/memory.js";
import { mergeDecisions, mergeMemories, mergeSafetyRules } from "../storage/workspace-merge.js";
import { testPlanContext } from "../storage/test-plan.js";
import { plansContext } from "../storage/plans.js";
import { listPendingAudits } from "../storage/sessions.js";

/**
 * Get full project context (oracle + decisions + safety + memory + test plan + plans).
 * When workspacePath provided, merges workspace + project data.
 */
export function getFullContext(projectPath: string, workspacePath?: string): string {
  const parts: string[] = [];

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

  if (parts.length === 0) {
    return "Project not initialized. Ask the user to run 'axme-code setup' in terminal.";
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
  // Returned markers already exclude stale (dead-PID) entries thanks to
  // listPendingAudits's internal pid check.
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
        const phase = p.currentChunk && p.chunks ? `${p.phase} chunk ${p.currentChunk}/${p.chunks}` : p.phase;
        return `- session ${p.sessionId.slice(0, 8)} at ${p.location} level, started ${startedAgo}s ago, phase=${phase}`;
      }),
      "",
      "**Agent action required**: tell the user about the pending audit(s) and offer two options:",
      "  1. Wait a few minutes and re-run `axme_context` to pick up the fresh knowledge before proceeding.",
      "  2. Add a TODO to check back in N minutes and continue in parallel until then, re-checking `axme_context` periodically until the pending list is empty.",
      "Keep the TODO open until all pending audits are gone.",
    ];
    parts.push(lines.join("\n"));
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
