/**
 * axme_init tool - initialize project knowledge base.
 *
 * Full 7-step init sequence:
 * 1. Oracle scan (LLM: Sonnet reads project, produces stack/structure/patterns/glossary)
 * 2. Decision scan (LLM: Sonnet extracts architectural decisions from docs/code)
 * 3. Presets (deterministic: apply preset bundle decisions)
 * 4. Memory seed (deterministic: seed preset memories)
 * 5. Safety scan (LLM: Haiku reads CI configs + CLAUDE.md for safety rules)
 * 6. Config (deterministic: write config.yaml)
 * 7. Sessions (deterministic: init session store)
 *
 * Fallback: if LLM scanners fail, falls back to deterministic scan.
 */

import { join } from "node:path";
import { ensureDir, pathExists } from "../storage/engine.js";
import { writeOracleFiles, initOracleDeterministic, oracleExists } from "../storage/oracle.js";
import { initDecisionStore, saveDecisions, listDecisions } from "../storage/decisions.js";
import { initMemoryStore, saveMemories, listMemories } from "../storage/memory.js";
import { initSafetyRules, loadSafetyRules, writeSafetyRules, safetyExists } from "../storage/safety.js";
import { writeConfig, configExists } from "../storage/config.js";
import { initSessionStore } from "../storage/sessions.js";
import { initDeployStore, writeChecklist } from "../storage/deploy.js";
import { generateTestPlan, writeTestPlan, testPlanExists } from "../storage/test-plan.js";
import { initPlanStore } from "../storage/plans.js";
import { bundlesToDecisions, bundlesToMemories, bundlesToDeployChecklists, applyPresetSafetyRules } from "../presets.js";
import { AXME_CODE_DIR, DEFAULT_PROJECT_CONFIG } from "../types.js";
import { addCost, zeroCost, type CostInfo } from "../utils/cost-extractor.js";
import { atomicWrite } from "../storage/engine.js";
import yaml from "js-yaml";

export interface InitResult {
  projectPath: string;
  created: boolean;
  oracle: { files: number; llm: boolean };
  decisions: { count: number; fromScan: number; fromPresets: number };
  memories: { count: number; fromPresets: number };
  safety: { created: boolean; llm: boolean; summary: string };
  config: boolean;
  cost: CostInfo;
  durationMs: number;
  errors: string[];
}

/**
 * Full project init with LLM scanners.
 * This is the primary init path - uses 3 LLM agents for deep project understanding.
 */
export async function initProjectWithLLM(projectPath: string, opts?: {
  presets?: string[];
  workspaceMode?: boolean;
}): Promise<InitResult> {
  const startTime = Date.now();
  const axmeDir = join(projectPath, AXME_CODE_DIR);
  const alreadyExists = pathExists(axmeDir);
  ensureDir(axmeDir);

  const presets = opts?.presets ?? DEFAULT_PROJECT_CONFIG.presets;
  let totalCost = zeroCost();
  const errors: string[] = [];

  // --- Step 1: Oracle scan (LLM) ---
  let oracleLlm = false;
  let oracleFiles = 0;
  if (!oracleExists(projectPath)) {
    try {
      const { runOracleScan } = await import("../agents/scanners/oracle.js");
      const result = await runOracleScan({
        projectPath,
        workspaceMode: opts?.workspaceMode,
      });
      writeOracleFiles(projectPath, result.files);
      totalCost = addCost(totalCost, result.cost);
      oracleLlm = true;
      oracleFiles = 4;
    } catch (err: any) {
      errors.push(`Oracle LLM scan failed (${err.message}), using deterministic fallback`);
      initOracleDeterministic(projectPath);
      oracleFiles = 4;
    }
  } else {
    oracleFiles = 4;
  }

  // --- Step 2: Decision scan (LLM) ---
  let scanDecisionCount = 0;
  initDecisionStore(projectPath);
  try {
    const { runDecisionScan } = await import("../agents/scanners/decision.js");
    const result = await runDecisionScan({ projectPath });
    if (result.decisions.length > 0) {
      saveDecisions(projectPath, result.decisions);
      scanDecisionCount = result.decisions.length;
    }
    totalCost = addCost(totalCost, result.cost);
  } catch (err: any) {
    errors.push(`Decision LLM scan failed (${err.message}), skipping`);
  }

  // --- Step 3: Presets (deterministic) ---
  let presetsDecisionCount = 0;
  const existing = listDecisions(projectPath);
  const startId = existing.length > 0
    ? Math.max(...existing.map(d => parseInt(d.id.replace("D-", ""), 10))) + 1
    : 1;
  const presetDecisions = bundlesToDecisions(presets, startId);
  if (presetDecisions.length > 0) {
    saveDecisions(projectPath, presetDecisions);
    presetsDecisionCount = presetDecisions.length;
  }

  // --- Step 4: Memory seed (deterministic) ---
  let presetsMemoryCount = 0;
  initMemoryStore(projectPath);
  const presetMemories = bundlesToMemories(presets);
  if (presetMemories.length > 0) {
    saveMemories(projectPath, presetMemories);
    presetsMemoryCount = presetMemories.length;
  }

  // --- Step 5: Safety scan (LLM) ---
  let safetyLlm = false;
  let safetySummary = "";
  if (!safetyExists(projectPath)) {
    const rules = initSafetyRules(projectPath);
    applyPresetSafetyRules(rules, presets);

    try {
      const { runSafetyScan } = await import("../agents/scanners/safety.js");
      const result = await runSafetyScan({ projectPath });
      totalCost = addCost(totalCost, result.cost);
      safetySummary = result.summary;
      safetyLlm = true;

      // Merge LLM-discovered rules with defaults + presets
      if (result.rules.git?.protectedBranches) {
        for (const b of result.rules.git.protectedBranches) {
          if (!rules.git.protectedBranches.includes(b)) rules.git.protectedBranches.push(b);
        }
      }
      if (result.rules.bash?.allowedPrefixes) {
        for (const cmd of result.rules.bash.allowedPrefixes) {
          if (!rules.bash.allowedPrefixes.includes(cmd)) rules.bash.allowedPrefixes.push(cmd);
        }
      }
      if (result.rules.bash?.deniedPrefixes) {
        for (const cmd of result.rules.bash.deniedPrefixes) {
          if (!rules.bash.deniedPrefixes.includes(cmd)) rules.bash.deniedPrefixes.push(cmd);
        }
      }
    } catch (err: any) {
      errors.push(`Safety LLM scan failed (${err.message}), using defaults + presets`);
    }

    writeSafetyRules(projectPath, rules);
  }

  // --- Step 5.5: Deploy checklists (deterministic + LLM) ---
  initDeployStore(projectPath);
  const presetChecklists = bundlesToDeployChecklists(presets);
  if (presetChecklists.staging?.length) {
    writeChecklist(projectPath, { environment: "staging", items: presetChecklists.staging });
  }
  if (presetChecklists.production?.length) {
    writeChecklist(projectPath, { environment: "production", items: presetChecklists.production });
  }

  // Deploy scanner (LLM, best-effort)
  try {
    const { runDeployScan } = await import("../agents/scanners/deploy.js");
    const deployResult = await runDeployScan({ projectPath });
    totalCost = addCost(totalCost, deployResult.cost);
    // Merge LLM-discovered items with preset items
    if (deployResult.stagingItems.length > 0 && presetChecklists.staging) {
      const existing = new Set(presetChecklists.staging.map(i => i.name.toLowerCase()));
      const newItems = deployResult.stagingItems.filter(i => !existing.has(i.name.toLowerCase()));
      if (newItems.length > 0) {
        writeChecklist(projectPath, { environment: "staging", items: [...presetChecklists.staging, ...newItems] });
      }
    }
    if (deployResult.prodItems.length > 0 && presetChecklists.production) {
      const existing = new Set(presetChecklists.production.map(i => i.name.toLowerCase()));
      const newItems = deployResult.prodItems.filter(i => !existing.has(i.name.toLowerCase()));
      if (newItems.length > 0) {
        writeChecklist(projectPath, { environment: "production", items: [...presetChecklists.production, ...newItems] });
      }
    }
  } catch (err: any) {
    errors.push(`Deploy LLM scan failed (${err.message}), using preset checklists only`);
  }

  // --- Step 6: Config ---
  let configCreated = false;
  if (!configExists(projectPath)) {
    writeConfig(projectPath, { ...DEFAULT_PROJECT_CONFIG, presets });
    configCreated = true;
  }

  // --- Step 7: Sessions + Plans + Test Plan ---
  initSessionStore(projectPath);
  initPlanStore(projectPath);

  if (!testPlanExists(projectPath)) {
    const testPlan = generateTestPlan(projectPath);
    if (testPlan.auto.length > 0 || testPlan.e2e.length > 0) {
      writeTestPlan(projectPath, testPlan);
    }
  }

  return {
    projectPath,
    created: !alreadyExists,
    oracle: { files: oracleFiles, llm: oracleLlm },
    decisions: { count: listDecisions(projectPath).length, fromScan: scanDecisionCount, fromPresets: presetsDecisionCount },
    memories: { count: listMemories(projectPath).length, fromPresets: presetsMemoryCount },
    safety: { created: !safetyExists(projectPath) || true, llm: safetyLlm, summary: safetySummary },
    config: configCreated,
    cost: totalCost,
    durationMs: Date.now() - startTime,
    errors,
  };
}

/**
 * Workspace init: Phase 1 (workspace level) + Phase 2 (per-project).
 */
export async function initWorkspaceWithLLM(workspacePath: string, opts?: {
  presets?: string[];
}): Promise<{ workspaceResult: InitResult; projectResults: InitResult[] }> {
  // Phase 1: workspace-level init
  const workspaceResult = await initProjectWithLLM(workspacePath, {
    presets: opts?.presets,
    workspaceMode: true,
  });

  // Generate workspace.yaml
  try {
    const { detectWorkspace } = await import("../utils/workspace-detector.js");
    const ws = detectWorkspace(workspacePath);
    if (ws.type !== "single") {
      const wsYaml = yaml.dump({
        name: ws.root.split("/").pop(),
        type: ws.type,
        manifest: ws.manifestPath,
        projects: ws.projects,
      }, { lineWidth: 120 });
      atomicWrite(join(workspacePath, AXME_CODE_DIR, "workspace.yaml"), wsYaml);
    }
  } catch {}

  // Phase 2: per-project init (only git repos)
  const projectResults: InitResult[] = [];
  try {
    const { detectWorkspace } = await import("../utils/workspace-detector.js");
    const ws = detectWorkspace(workspacePath);
    const { existsSync } = await import("node:fs");

    for (const project of ws.projects) {
      const projPath = join(workspacePath, project.path);
      // Only init actual git repos
      if (!existsSync(join(projPath, ".git"))) continue;

      try {
        const result = await initProjectWithLLM(projPath, { presets: opts?.presets });
        projectResults.push(result);
      } catch (err: any) {
        projectResults.push({
          projectPath: projPath, created: false,
          oracle: { files: 0, llm: false },
          decisions: { count: 0, fromScan: 0, fromPresets: 0 },
          memories: { count: 0, fromPresets: 0 },
          safety: { created: false, llm: false, summary: "" },
          config: false, cost: zeroCost(),
          durationMs: 0, errors: [`Init failed: ${err.message}`],
        });
      }
    }
  } catch {}

  return { workspaceResult, projectResults };
}

/**
 * Quick deterministic-only init (no LLM, for CLI setup command).
 * Used when user runs `axme-code setup` without Claude API access.
 */
export function initProjectDeterministic(projectPath: string, opts?: { presets?: string[] }): InitResult {
  const startTime = Date.now();
  const axmeDir = join(projectPath, AXME_CODE_DIR);
  const alreadyExists = pathExists(axmeDir);
  ensureDir(axmeDir);

  const presets = opts?.presets ?? DEFAULT_PROJECT_CONFIG.presets;

  // Oracle - deterministic only
  if (!oracleExists(projectPath)) {
    initOracleDeterministic(projectPath);
  }

  // Decisions - presets only
  let presetsDecisionCount = 0;
  if (!pathExists(join(axmeDir, "decisions"))) {
    initDecisionStore(projectPath);
    const presetDecisions = bundlesToDecisions(presets, 1);
    if (presetDecisions.length > 0) {
      saveDecisions(projectPath, presetDecisions);
      presetsDecisionCount = presetDecisions.length;
    }
  }

  // Memory - presets only
  let presetsMemoryCount = 0;
  if (!pathExists(join(axmeDir, "memory"))) {
    initMemoryStore(projectPath);
    const presetMemories = bundlesToMemories(presets);
    if (presetMemories.length > 0) {
      saveMemories(projectPath, presetMemories);
      presetsMemoryCount = presetMemories.length;
    }
  }

  // Safety - defaults + presets
  if (!safetyExists(projectPath)) {
    const rules = initSafetyRules(projectPath);
    applyPresetSafetyRules(rules, presets);
    writeSafetyRules(projectPath, rules);
  }

  // Deploy checklists from presets
  initDeployStore(projectPath);
  const presetChecklists = bundlesToDeployChecklists(presets);
  if (presetChecklists.staging?.length) writeChecklist(projectPath, { environment: "staging", items: presetChecklists.staging });
  if (presetChecklists.production?.length) writeChecklist(projectPath, { environment: "production", items: presetChecklists.production });

  // Config
  let configCreated = false;
  if (!configExists(projectPath)) {
    writeConfig(projectPath, { ...DEFAULT_PROJECT_CONFIG, presets });
    configCreated = true;
  }

  // Sessions + Plans + Test Plan
  initSessionStore(projectPath);
  initPlanStore(projectPath);
  if (!testPlanExists(projectPath)) {
    const testPlan = generateTestPlan(projectPath);
    if (testPlan.auto.length > 0) writeTestPlan(projectPath, testPlan);
  }

  return {
    projectPath,
    created: !alreadyExists,
    oracle: { files: 4, llm: false },
    decisions: { count: listDecisions(projectPath).length, fromScan: 0, fromPresets: presetsDecisionCount },
    memories: { count: listMemories(projectPath).length, fromPresets: presetsMemoryCount },
    safety: { created: true, llm: false, summary: "" },
    config: configCreated,
    cost: zeroCost(),
    durationMs: Date.now() - startTime,
    errors: [],
  };
}
