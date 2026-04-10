/**
 * Safety tools - axme_update_safety.
 */

import { updateSafetyRule, showSafety, safetyContext } from "../storage/safety.js";
import { logSafetyUpdated } from "../storage/worklog.js";

export type SafetyRuleType = "git_protected_branch" | "bash_deny" | "bash_allow" | "fs_deny" | "fs_readonly";

export function updateSafetyTool(
  projectPath: string,
  ruleType: SafetyRuleType,
  value: string,
  sessionId?: string,
): { updated: boolean; ruleType: string; value: string } {
  updateSafetyRule(projectPath, ruleType, value);
  if (sessionId) {
    logSafetyUpdated(projectPath, sessionId, ruleType, value);
  }
  return { updated: true, ruleType, value };
}

export function showSafetyTool(projectPath: string): string {
  return showSafety(projectPath);
}

export function getSafetyContext(projectPath: string): string {
  return safetyContext(projectPath);
}
