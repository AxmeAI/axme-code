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
import { bundlesToDecisions, bundlesToMemories, applyPresetSafetyRules } from "../presets.js";
import { AXME_CODE_DIR, DEFAULT_PROJECT_CONFIG } from "../types.js";
import { addCost, zeroCost, type CostInfo } from "../utils/cost-extractor.js";

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

  // --- Step 6: Config ---
  let configCreated = false;
  if (!configExists(projectPath)) {
    writeConfig(projectPath, { ...DEFAULT_PROJECT_CONFIG, presets });
    configCreated = true;
  }

  // --- Step 7: Sessions ---
  initSessionStore(projectPath);

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

  // Config
  let configCreated = false;
  if (!configExists(projectPath)) {
    writeConfig(projectPath, { ...DEFAULT_PROJECT_CONFIG, presets });
    configCreated = true;
  }

  // Sessions
  initSessionStore(projectPath);

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
