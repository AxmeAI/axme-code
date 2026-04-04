/**
 * Context tools - axme_context, axme_oracle, axme_decisions.
 *
 * Read project knowledge base for agent prompts.
 */

import { oracleContext, showOracle, oracleExists } from "../storage/oracle.js";
import { decisionsContext, showDecisions, enforceableDecisionsContext } from "../storage/decisions.js";
import { safetyContext } from "../storage/safety.js";
import { allMemoryContext } from "../storage/memory.js";

/**
 * Get full project context (oracle + decisions + safety + memory).
 * This is the primary context injection for agents.
 */
export function getFullContext(projectPath: string): string {
  const parts: string[] = [];

  const oracle = oracleContext(projectPath);
  if (oracle) parts.push("# Project Oracle\n\n" + oracle);

  const decisions = decisionsContext(projectPath);
  if (decisions) parts.push(decisions);

  const safety = safetyContext(projectPath);
  if (safety) parts.push(safety);

  const memory = allMemoryContext(projectPath);
  if (memory) parts.push(memory);

  if (parts.length === 0) {
    return "Project not initialized. Run axme_init first.";
  }

  return parts.join("\n\n");
}

/**
 * Get oracle data for display.
 */
export function getOracle(projectPath: string): string {
  if (!oracleExists(projectPath)) {
    return "Oracle not initialized. Run axme_init first.";
  }
  return showOracle(projectPath);
}

/**
 * Get decisions for display.
 */
export function getDecisions(projectPath: string): string {
  return showDecisions(projectPath);
}

/**
 * Get enforceable rules only (for reviewer).
 */
export function getEnforceableRules(projectPath: string): string {
  return enforceableDecisionsContext(projectPath);
}
