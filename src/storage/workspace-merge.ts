/**
 * Workspace merge functions - combine workspace-level and project-level storage.
 *
 * Principle: workspace extends, project overrides/specializes.
 */

import type { Decision, Memory, SafetyRules, OracleData, ProjectConfig } from "../types.js";

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
 * Merge safety rules: union of both sets.
 * Both workspace and project rules apply simultaneously.
 */
export function mergeSafetyRules(workspace: SafetyRules, project: SafetyRules): SafetyRules {
  return {
    git: {
      protectedBranches: dedupe([...workspace.git.protectedBranches, ...project.git.protectedBranches]),
      allowForcePush: workspace.git.allowForcePush && project.git.allowForcePush,
      allowDirectPushToMain: workspace.git.allowDirectPushToMain && project.git.allowDirectPushToMain,
      requirePrForMain: workspace.git.requirePrForMain || project.git.requirePrForMain,
    },
    bash: {
      allowedPrefixes: dedupe([...workspace.bash.allowedPrefixes, ...project.bash.allowedPrefixes]),
      deniedPrefixes: dedupe([...workspace.bash.deniedPrefixes, ...project.bash.deniedPrefixes]),
      deniedCommands: dedupe([...workspace.bash.deniedCommands, ...project.bash.deniedCommands]),
    },
    filesystem: {
      readOnlyPaths: dedupe([...workspace.filesystem.readOnlyPaths, ...project.filesystem.readOnlyPaths]),
      deniedPaths: dedupe([...workspace.filesystem.deniedPaths, ...project.filesystem.deniedPaths]),
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

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
