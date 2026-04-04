/**
 * axme_init tool - initialize project knowledge base.
 *
 * Creates .axme-code/ directory with:
 * - oracle/ (deterministic scan or LLM scan)
 * - decisions/ (from presets)
 * - memory/ (from presets)
 * - safety/ (rules.yaml)
 * - config.yaml
 * - sessions/
 */

import { join } from "node:path";
import { ensureDir, pathExists } from "../storage/engine.js";
import { initOracleDeterministic, oracleExists } from "../storage/oracle.js";
import { initDecisionStore, saveDecisions, listDecisions } from "../storage/decisions.js";
import { initMemoryStore, saveMemories, listMemories } from "../storage/memory.js";
import { initSafetyRules, loadSafetyRules, writeSafetyRules, safetyExists } from "../storage/safety.js";
import { writeConfig, configExists, readConfig } from "../storage/config.js";
import { initSessionStore } from "../storage/sessions.js";
import { logSessionStart } from "../storage/worklog.js";
import { bundlesToDecisions, bundlesToMemories, applyPresetSafetyRules } from "../presets.js";
import { AXME_CODE_DIR, DEFAULT_PROJECT_CONFIG } from "../types.js";

export interface InitResult {
  projectPath: string;
  created: boolean;
  oracle: { files: number };
  decisions: { count: number; fromPresets: number };
  memories: { count: number; fromPresets: number };
  safety: boolean;
  config: boolean;
}

export function initProject(projectPath: string, opts?: { presets?: string[] }): InitResult {
  const axmeDir = join(projectPath, AXME_CODE_DIR);
  const alreadyExists = pathExists(axmeDir);
  ensureDir(axmeDir);

  // Oracle - deterministic scan (LLM scan is separate, called by agent after init)
  let oracleFileCount = 0;
  if (!oracleExists(projectPath)) {
    const data = initOracleDeterministic(projectPath);
    oracleFileCount = 4;
  } else {
    oracleFileCount = 4; // already exists
  }

  // Decisions from presets
  const presets = opts?.presets ?? DEFAULT_PROJECT_CONFIG.presets;
  let presetsDecisionCount = 0;
  if (!pathExists(join(axmeDir, "decisions"))) {
    initDecisionStore(projectPath);
    const existing = listDecisions(projectPath);
    const startId = existing.length > 0
      ? Math.max(...existing.map(d => parseInt(d.id.replace("D-", ""), 10))) + 1
      : 1;
    const presetDecisions = bundlesToDecisions(presets, startId);
    if (presetDecisions.length > 0) {
      saveDecisions(projectPath, presetDecisions);
      presetsDecisionCount = presetDecisions.length;
    }
  }

  // Memory from presets
  let presetsMemoryCount = 0;
  if (!pathExists(join(axmeDir, "memory"))) {
    initMemoryStore(projectPath);
    const presetMemories = bundlesToMemories(presets);
    if (presetMemories.length > 0) {
      saveMemories(projectPath, presetMemories);
      presetsMemoryCount = presetMemories.length;
    }
  }

  // Safety rules
  let safetyCreated = false;
  if (!safetyExists(projectPath)) {
    const rules = initSafetyRules(projectPath);
    applyPresetSafetyRules(rules, presets);
    writeSafetyRules(projectPath, rules);
    safetyCreated = true;
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
    oracle: { files: oracleFileCount },
    decisions: { count: listDecisions(projectPath).length, fromPresets: presetsDecisionCount },
    memories: { count: listMemories(projectPath).length, fromPresets: presetsMemoryCount },
    safety: safetyCreated,
    config: configCreated,
  };
}
