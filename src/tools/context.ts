/**
 * Context tools - axme_context, axme_oracle, axme_decisions.
 *
 * Read project knowledge base for agent prompts.
 * Workspace-aware: merges workspace-level + project-level data when workspace_path provided.
 */

import { oracleContext, showOracle, oracleExists } from "../storage/oracle.js";
import { decisionsContext, showDecisions, enforceableDecisionsContext, listDecisions } from "../storage/decisions.js";
import { safetyContext, loadSafetyRules } from "../storage/safety.js";
import { allMemoryContext, listMemories } from "../storage/memory.js";
import { mergeDecisions, mergeMemories, mergeSafetyRules } from "../storage/workspace-merge.js";
import { testPlanContext } from "../storage/test-plan.js";
import { plansContext } from "../storage/plans.js";

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
    return "Project not initialized. Run axme_init first.";
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
