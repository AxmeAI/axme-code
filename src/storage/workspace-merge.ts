/**
 * Workspace merge functions - combine workspace-level and project-level storage.
 *
 * Principle: workspace extends, project overrides/specializes.
 */

import type { Decision, Memory, SafetyRules, OracleData, ProjectConfig } from "../types.js";
// Reuse the canonical union-merge from safety.ts instead of duplicating here.
// loadMergedSafetyRules in safety.ts calls the same underlying unionMergeSafety.
import { loadMergedSafetyRules } from "./safety.js";

/**
 * Merge decisions: workspace + project concatenated.
 * Project decisions win on same ID conflict.
 */
export function mergeDecisions(workspace: Decision[], project: Decision[]): Decision[] {
  const projectIds = new Set(project.map(d => d.id));
  const wsFiltered = workspace.filter(d => !projectIds.has(d.id));
  return [...wsFiltered, ...project];
}

/**
 * Merge safety rules: delegates to safety.ts unionMergeSafety (via loadMergedSafetyRules).
 * Kept as export for backward compat with context.ts callers.
 */
export { loadMergedSafetyRules as mergeSafetyRulesFromPaths };

/**
 * Merge safety rules from pre-loaded objects. Uses same union logic as
 * loadMergedSafetyRules but accepts already-loaded SafetyRules instead of paths.
 *
 * Union principle: deny lists union, allow lists union, boolean flags: AND for
 * allow (both must allow), OR for require (either can require).
 */
export function mergeSafetyRules(workspace: SafetyRules, project: SafetyRules): SafetyRules {
  const uniq = (arr: string[]) => Array.from(new Set(arr));
  return {
    git: {
      protectedBranches: uniq([...workspace.git.protectedBranches, ...project.git.protectedBranches]),
      allowForcePush: workspace.git.allowForcePush && project.git.allowForcePush,
      allowDirectPushToMain: workspace.git.allowDirectPushToMain && project.git.allowDirectPushToMain,
      requirePrForMain: workspace.git.requirePrForMain || project.git.requirePrForMain,
    },
    bash: {
      allowedPrefixes: uniq([...workspace.bash.allowedPrefixes, ...project.bash.allowedPrefixes]),
      deniedPrefixes: uniq([...workspace.bash.deniedPrefixes, ...project.bash.deniedPrefixes]),
      deniedCommands: uniq([...workspace.bash.deniedCommands, ...project.bash.deniedCommands]),
    },
    filesystem: {
      readOnlyPaths: uniq([...workspace.filesystem.readOnlyPaths, ...project.filesystem.readOnlyPaths]),
      deniedPaths: uniq([...workspace.filesystem.deniedPaths, ...project.filesystem.deniedPaths]),
    },
  };
}

/**
 * Merge memories: concatenate all, dedupe by slug (project wins).
 */
export function mergeMemories(workspace: Memory[], project: Memory[]): Memory[] {
  const projectSlugs = new Set(project.map(m => m.slug));
  const wsFiltered = workspace.filter(m => !projectSlugs.has(m.slug));
  return [...wsFiltered, ...project];
}

/**
 * Merge config: project overrides workspace defaults.
 */
export function mergeConfig(workspace: ProjectConfig, project: ProjectConfig): ProjectConfig {
  return { ...workspace, ...project };
}

/**
 * Merged oracle: both levels available, labeled.
 */
export interface MergedOracle {
  workspace: OracleData | null;
  project: OracleData | null;
}

export function mergeOracle(workspace: OracleData | null, project: OracleData | null): MergedOracle {
  return { workspace, project };
}

/**
 * Format merged oracle as context string for agents.
 */
export function mergedOracleContext(merged: MergedOracle): string {
  const parts: string[] = [];

  if (merged.workspace) {
    parts.push("## Workspace Context");
    if (merged.workspace.structure) {
      const dirs = merged.workspace.structure.directories.map(d => `- ${d.path}: ${d.description}`).join("\n");
      if (dirs) parts.push(`### Projects\n${dirs}`);
    }
    if (merged.workspace.patterns) {
      parts.push(`### Workspace Conventions\n${merged.workspace.patterns}`);
    }
  }

  if (merged.project) {
    parts.push("## Project Context");
    if (merged.project.stack) {
      const items: string[] = [];
      if (merged.project.stack.languages.length) items.push(`Languages: ${merged.project.stack.languages.join(", ")}`);
      if (merged.project.stack.frameworks.length) items.push(`Frameworks: ${merged.project.stack.frameworks.join(", ")}`);
      if (items.length) parts.push(`### Stack\n${items.join("\n")}`);
    }
    if (merged.project.patterns) parts.push(`### Coding Patterns\n${merged.project.patterns}`);
    if (merged.project.glossary) parts.push(`### Glossary\n${merged.project.glossary}`);
  }

  return parts.join("\n\n");
}

