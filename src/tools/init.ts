/**
 * axme_init tool - initialize project knowledge base.
 *
 * LLM scanners run in PARALLEL (oracle + decision + safety + deploy simultaneously).
 * Workspace init runs repos with concurrency limit.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
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
 * Full project init with LLM scanners running in parallel.
 */
export async function initProjectWithLLM(projectPath: string, opts?: {
  presets?: string[];
  workspaceMode?: boolean;
  force?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<InitResult> {
  const startTime = Date.now();
  const axmeDir = join(projectPath, AXME_CODE_DIR);
  const alreadyExists = pathExists(axmeDir);

  // Skip if already fully initialized (has LLM-scanned decisions)
  if (alreadyExists && !opts?.force) {
    const existing = listDecisions(projectPath);
    const hasLlmScan = existing.some(d => d.source === "init-scan");
    if (hasLlmScan) {
      return {
        projectPath, created: false,
        oracle: { files: 4, llm: true },
        decisions: { count: existing.length, fromScan: existing.filter(d => d.source === "init-scan").length, fromPresets: existing.filter(d => d.source === "preset").length },
        memories: { count: listMemories(projectPath).length, fromPresets: 0 },
        safety: { created: false, llm: true, summary: "already initialized" },
        config: false, cost: zeroCost(), durationMs: 0, errors: [],
      };
    }
  }

  ensureDir(axmeDir);

  const presets = opts?.presets ?? DEFAULT_PROJECT_CONFIG.presets;
  let totalCost = zeroCost();
  const errors: string[] = [];

  // --- Deterministic steps first (fast, no LLM) ---
  initDecisionStore(projectPath);
  initMemoryStore(projectPath);
  initSessionStore(projectPath);
  initPlanStore(projectPath);
  initDeployStore(projectPath);

  // Presets: decisions
  let presetsDecisionCount = 0;
  const presetDecisions = bundlesToDecisions(presets, 1);
  if (presetDecisions.length > 0) {
    saveDecisions(projectPath, presetDecisions);
    presetsDecisionCount = presetDecisions.length;
  }

  // Presets: memories
  let presetsMemoryCount = 0;
  const presetMemories = bundlesToMemories(presets);
  if (presetMemories.length > 0) {
    saveMemories(projectPath, presetMemories);
    presetsMemoryCount = presetMemories.length;
  }

  // Presets: safety
  if (!safetyExists(projectPath)) {
    const rules = initSafetyRules(projectPath);
    applyPresetSafetyRules(rules, presets);
    writeSafetyRules(projectPath, rules);
  }

  // Presets: deploy checklists
  const presetChecklists = bundlesToDeployChecklists(presets);
  if (presetChecklists.staging?.length) writeChecklist(projectPath, { environment: "staging", items: presetChecklists.staging });
  if (presetChecklists.production?.length) writeChecklist(projectPath, { environment: "production", items: presetChecklists.production });

  // Config
  let configCreated = false;
  if (!configExists(projectPath)) {
    writeConfig(projectPath, { ...DEFAULT_PROJECT_CONFIG, presets });
    configCreated = true;
  }

  // Test plan
  if (!testPlanExists(projectPath)) {
    const testPlan = generateTestPlan(projectPath);
    if (testPlan.auto.length > 0 || testPlan.e2e.length > 0) writeTestPlan(projectPath, testPlan);
  }

  // --- LLM scanners in PARALLEL ---
  const log = opts?.onProgress ?? (() => {});
  const projectName = projectPath.split("/").pop();
  log(`  [${projectName}] LLM scanning (oracle + decisions + safety + deploy)...`);

  let oracleLlm = false;
  let oracleFiles = 0;
  let scanDecisionCount = 0;
  let safetyLlm = false;
  let safetySummary = "";

  const scanners = await Promise.allSettled([
    // Oracle scan
    (async () => {
      if (oracleExists(projectPath)) return { type: "oracle" as const, skipped: true };
      const { runOracleScan } = await import("../agents/scanners/oracle.js");
      return { type: "oracle" as const, result: await runOracleScan({ projectPath, workspaceMode: opts?.workspaceMode }) };
    })(),
    // Decision scan
    (async () => {
      const { runDecisionScan } = await import("../agents/scanners/decision.js");
      return { type: "decision" as const, result: await runDecisionScan({ projectPath }) };
    })(),
    // Safety scan
    (async () => {
      if (safetyExists(projectPath)) return { type: "safety" as const, skipped: true };
      const { runSafetyScan } = await import("../agents/scanners/safety.js");
      return { type: "safety" as const, result: await runSafetyScan({ projectPath }) };
    })(),
    // Deploy scan
    (async () => {
      const { runDeployScan } = await import("../agents/scanners/deploy.js");
      return { type: "deploy" as const, result: await runDeployScan({ projectPath }) };
    })(),
  ]);

  // Process results
  log(`  [${projectName}] Scanners complete, processing results...`);
  for (const settled of scanners) {
    if (settled.status === "rejected") {
      errors.push(`LLM scan failed: ${settled.reason?.message ?? settled.reason}`);
      continue;
    }
    const val = settled.value;
    if ("skipped" in val) continue;

    if (val.type === "oracle" && val.result) {
      writeOracleFiles(projectPath, val.result.files);
      totalCost = addCost(totalCost, val.result.cost);
      oracleLlm = true;
      oracleFiles = 4;
    }

    if (val.type === "decision" && val.result) {
      if (val.result.decisions.length > 0) {
        saveDecisions(projectPath, val.result.decisions);
        scanDecisionCount = val.result.decisions.length;
      }
      totalCost = addCost(totalCost, val.result.cost);
    }

    if (val.type === "safety" && val.result) {
      totalCost = addCost(totalCost, val.result.cost);
      safetySummary = val.result.summary;
      safetyLlm = true;
      // Merge LLM rules into existing
      const rules = loadSafetyRules(projectPath);
      if (val.result.rules.git?.protectedBranches) {
        for (const b of val.result.rules.git.protectedBranches) {
          if (!rules.git.protectedBranches.includes(b)) rules.git.protectedBranches.push(b);
        }
      }
      if (val.result.rules.bash?.allowedPrefixes) {
        for (const cmd of val.result.rules.bash.allowedPrefixes) {
          if (!rules.bash.allowedPrefixes.includes(cmd)) rules.bash.allowedPrefixes.push(cmd);
        }
      }
      if (val.result.rules.bash?.deniedPrefixes) {
        for (const cmd of val.result.rules.bash.deniedPrefixes) {
          if (!rules.bash.deniedPrefixes.includes(cmd)) rules.bash.deniedPrefixes.push(cmd);
        }
      }
      writeSafetyRules(projectPath, rules);
    }

    if (val.type === "deploy" && val.result) {
      totalCost = addCost(totalCost, val.result.cost);
      if (val.result.stagingItems.length > 0 && presetChecklists.staging) {
        const existing = new Set(presetChecklists.staging.map(i => i.name.toLowerCase()));
        const newItems = val.result.stagingItems.filter(i => !existing.has(i.name.toLowerCase()));
        if (newItems.length > 0) writeChecklist(projectPath, { environment: "staging", items: [...presetChecklists.staging, ...newItems] });
      }
      if (val.result.prodItems.length > 0 && presetChecklists.production) {
        const existing = new Set(presetChecklists.production.map(i => i.name.toLowerCase()));
        const newItems = val.result.prodItems.filter(i => !existing.has(i.name.toLowerCase()));
        if (newItems.length > 0) writeChecklist(projectPath, { environment: "production", items: [...presetChecklists.production, ...newItems] });
      }
    }
  }

  // Fallback: if oracle scan didn't run or failed
  if (!oracleLlm && !oracleExists(projectPath)) {
    initOracleDeterministic(projectPath);
    oracleFiles = 4;
  } else if (oracleExists(projectPath) && !oracleLlm) {
    oracleFiles = 4;
  }

  return {
    projectPath,
    created: !alreadyExists,
    oracle: { files: oracleFiles, llm: oracleLlm },
    decisions: { count: listDecisions(projectPath).length, fromScan: scanDecisionCount, fromPresets: presetsDecisionCount },
    memories: { count: listMemories(projectPath).length, fromPresets: presetsMemoryCount },
    safety: { created: true, llm: safetyLlm, summary: safetySummary },
    config: configCreated,
    cost: totalCost,
    durationMs: Date.now() - startTime,
    errors,
  };
}

/**
 * Workspace init: Phase 1 (workspace level) + Phase 2 (per-project with concurrency).
 */
export async function initWorkspaceWithLLM(workspacePath: string, opts?: {
  presets?: string[];
  onProgress?: (msg: string) => void;
}): Promise<{ workspaceResult: InitResult; projectResults: InitResult[] }> {
  const log = opts?.onProgress ?? (() => {});

  // Phase 1: workspace-level init
  log("Phase 1: Scanning workspace overview...");
  const workspaceResult = await initProjectWithLLM(workspacePath, {
    presets: opts?.presets,
    workspaceMode: true,
    onProgress: log,
  });
  log(`Phase 1 complete: ${workspaceResult.decisions.count} decisions, $${workspaceResult.cost.costUsd.toFixed(2)}`);

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

  // Phase 2: per-project init with concurrency limit
  const CONCURRENCY = 3; // max 3 repos scanning simultaneously
  const projectResults: InitResult[] = [];

  try {
    const { detectWorkspace } = await import("../utils/workspace-detector.js");
    const ws = detectWorkspace(workspacePath);

    // Filter to git repos only
    const gitRepos = ws.projects.filter(p => existsSync(join(workspacePath, p.path, ".git")));
    log(`Phase 2: Scanning ${gitRepos.length} repos (${CONCURRENCY} parallel)...`);

    // Run in batches of CONCURRENCY
    let completed = 0;
    for (let i = 0; i < gitRepos.length; i += CONCURRENCY) {
      const batch = gitRepos.slice(i, i + CONCURRENCY);
      const batchNum = Math.floor(i / CONCURRENCY) + 1;
      const totalBatches = Math.ceil(gitRepos.length / CONCURRENCY);
      log(`Batch ${batchNum}/${totalBatches}: ${batch.map(p => p.name).join(", ")}`);

      const batchResults = await Promise.allSettled(
        batch.map(project => initProjectWithLLM(join(workspacePath, project.path), { presets: opts?.presets, onProgress: log }))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const settled = batchResults[j];
        completed++;
        if (settled.status === "fulfilled") {
          const r = settled.value;
          const name = r.projectPath.split("/").pop();
          if (r.durationMs === 0) {
            log(`  [${completed}/${gitRepos.length}] ${name}: skipped (already initialized)`);
          } else {
            log(`  [${completed}/${gitRepos.length}] ${name}: ${r.decisions.count} decisions, $${r.cost.costUsd.toFixed(2)}, ${(r.durationMs / 1000).toFixed(0)}s`);
          }
          projectResults.push(r);
        } else {
          log(`  [${completed}/${gitRepos.length}] ${batch[j].name}: FAILED (${settled.reason?.message ?? "unknown"})`);
          projectResults.push({
            projectPath: join(workspacePath, batch[j].path),
            created: false,
            oracle: { files: 0, llm: false },
            decisions: { count: 0, fromScan: 0, fromPresets: 0 },
            memories: { count: 0, fromPresets: 0 },
            safety: { created: false, llm: false, summary: "" },
            config: false,
            cost: zeroCost(),
            durationMs: 0,
            errors: [`Init failed: ${settled.reason?.message ?? settled.reason}`],
          });
        }
      }
    }
  } catch {}

  return { workspaceResult, projectResults };
}

/**
 * Quick deterministic-only init (no LLM, for fallback).
 */
export function initProjectDeterministic(projectPath: string, opts?: { presets?: string[] }): InitResult {
  const startTime = Date.now();
  const axmeDir = join(projectPath, AXME_CODE_DIR);
  const alreadyExists = pathExists(axmeDir);
  ensureDir(axmeDir);

  const presets = opts?.presets ?? DEFAULT_PROJECT_CONFIG.presets;

  if (!oracleExists(projectPath)) initOracleDeterministic(projectPath);

  let presetsDecisionCount = 0;
  if (!pathExists(join(axmeDir, "decisions"))) {
    initDecisionStore(projectPath);
    const presetDecisions = bundlesToDecisions(presets, 1);
    if (presetDecisions.length > 0) { saveDecisions(projectPath, presetDecisions); presetsDecisionCount = presetDecisions.length; }
  }

  let presetsMemoryCount = 0;
  if (!pathExists(join(axmeDir, "memory"))) {
    initMemoryStore(projectPath);
    const presetMemories = bundlesToMemories(presets);
    if (presetMemories.length > 0) { saveMemories(projectPath, presetMemories); presetsMemoryCount = presetMemories.length; }
  }

  if (!safetyExists(projectPath)) {
    const rules = initSafetyRules(projectPath);
    applyPresetSafetyRules(rules, presets);
    writeSafetyRules(projectPath, rules);
  }

  initDeployStore(projectPath);
  const presetChecklists = bundlesToDeployChecklists(presets);
  if (presetChecklists.staging?.length) writeChecklist(projectPath, { environment: "staging", items: presetChecklists.staging });
  if (presetChecklists.production?.length) writeChecklist(projectPath, { environment: "production", items: presetChecklists.production });

  let configCreated = false;
  if (!configExists(projectPath)) { writeConfig(projectPath, { ...DEFAULT_PROJECT_CONFIG, presets }); configCreated = true; }

  initSessionStore(projectPath);
  initPlanStore(projectPath);
  if (!testPlanExists(projectPath)) {
    const testPlan = generateTestPlan(projectPath);
    if (testPlan.auto.length > 0) writeTestPlan(projectPath, testPlan);
  }

  return {
    projectPath, created: !alreadyExists,
    oracle: { files: 4, llm: false },
    decisions: { count: listDecisions(projectPath).length, fromScan: 0, fromPresets: presetsDecisionCount },
    memories: { count: listMemories(projectPath).length, fromPresets: presetsMemoryCount },
    safety: { created: true, llm: false, summary: "" },
    config: configCreated, cost: zeroCost(), durationMs: Date.now() - startTime, errors: [],
  };
}
