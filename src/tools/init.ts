/**
 * axme_init tool - initialize project knowledge base.
 *
 * LLM scanners run in PARALLEL (oracle + decision + safety + deploy simultaneously).
 * Workspace init runs repos with concurrency limit.
 */

import { join, basename } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
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
import { atomicWrite, removeFile } from "../storage/engine.js";
import { findClaudePath } from "../utils/agent-options.js";
import yaml from "js-yaml";

/**
 * Heuristic: how few non-trivial files in the project tree before we treat
 * it as "effectively empty" and skip the LLM scan block? Three covers the
 * fresh-repo case (a `git init` + maybe a README + .gitignore = 0-1
 * non-trivial files) without false-positiving on real but small projects
 * (a tiny library is usually 5+ files).
 */
const EMPTY_PROJECT_THRESHOLD = 3;

/**
 * Directories the empty-project walk skips entirely. Build outputs and
 * vendor trees can contain millions of files but don't represent "user
 * code" — including them would mean every node_modules-bearing project
 * looks "huge" even when newly initialised.
 */
const EMPTY_PROBE_IGNORE_DIRS = new Set([
  ".git", ".axme-code", "node_modules", "dist", "build", ".next",
  "target", ".venv", "venv", "__pycache__", ".idea", ".vscode",
  "out", "out-test", ".gradle", ".dart_tool", "bin", "obj", ".pytest_cache",
  ".turbo", ".cache", "coverage",
]);

/**
 * Files that count as boilerplate, not "user code" — a folder with just
 * a README + LICENSE + .gitignore is still effectively empty for our
 * purposes (LLM scanners would produce empty STACK/STRUCTURE output).
 */
const EMPTY_PROBE_TRIVIAL_FILES = new Set([
  "README.md", "README", "README.txt", "README.rst",
  "LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING",
  ".gitignore", ".gitattributes", ".editorconfig",
  "CLAUDE.md", "AGENTS.md", ".cursorrules",
]);

/**
 * Walk the project tree (capped depth + early exit) and return true when
 * fewer than EMPTY_PROJECT_THRESHOLD non-trivial files are present. Cheap
 * — exits as soon as the threshold is reached, never enters ignored
 * dirs, never reads file content.
 *
 * Trade-off: this is a heuristic, not a sandbox. False positives (real
 * project misidentified as empty) result in presets-only setup, which is
 * still useful and the user can re-run with `--force` after adding code.
 * False negatives (truly empty project misidentified as non-empty) mean
 * we run the LLM scan unnecessarily — annoying but not broken.
 */
function isEffectivelyEmpty(projectPath: string): boolean {
  let count = 0;
  function walk(dir: string, depth: number): void {
    if (depth > 4 || count >= EMPTY_PROJECT_THRESHOLD) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (count >= EMPTY_PROJECT_THRESHOLD) return;
      if (EMPTY_PROBE_IGNORE_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) {
        walk(full, depth + 1);
      } else if (!EMPTY_PROBE_TRIVIAL_FILES.has(entry)) {
        count++;
      }
    }
  }
  walk(projectPath, 0);
  return count < EMPTY_PROJECT_THRESHOLD;
}

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
  /** Number of LLM scanners that actually executed (max 4: oracle/decision/safety/deploy). 0 in deterministic-only fallback. Used for telemetry. */
  scannersRun: number;
  /** Number of LLM scanners that failed (rejected or returned an error). Used for telemetry. */
  scannersFailed: number;
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
        scannersRun: 0, scannersFailed: 0,
      };
    }
  }

  ensureDir(axmeDir);

  // Setup lock — prevent concurrent setup runs (plugin may trigger multiple)
  const lockPath = join(axmeDir, "setup.lock");
  if (pathExists(lockPath)) {
    return {
      projectPath, created: false,
      oracle: { files: 0, llm: false },
      decisions: { count: 0, fromScan: 0, fromPresets: 0 },
      memories: { count: 0, fromPresets: 0 },
      safety: { created: false, llm: false, summary: "setup already running" },
      config: false, cost: zeroCost(), durationMs: 0, errors: ["Setup already in progress"],
      scannersRun: 0, scannersFailed: 0,
    };
  }
  atomicWrite(lockPath, new Date().toISOString());

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
  const projectName = basename(projectPath);

  let oracleLlm = false;
  let oracleFiles = 0;
  let scanDecisionCount = 0;
  let safetyLlm = false;
  let safetySummary = "";

  // Empty-project short-circuit: an effectively-empty folder (fresh
  // `git init`, maybe a README) has nothing for the LLM scanners to
  // analyse. They would still spend 1-3 minutes round-tripping to
  // Claude only to produce empty STACK/STRUCTURE/decisions output, plus
  // the user sees no progress between "starting scanners" and "scanners
  // complete". Skip them entirely; presets + deterministic oracle init
  // (the existing fallback below) produce the same end state instantly.
  // Re-run with `--force` after adding code if you want LLM scan later.
  const empty = isEffectivelyEmpty(projectPath);

  // Pre-flight: require the `claude` CLI to be installed (unless we're
  // skipping LLM scan anyway). Without it the Agent SDK bundled inside us
  // crashes on `fileURLToPath(undefined)` before it can reach the user's
  // OAuth/API key. Skip cleanly and surface a friendly error rather than
  // leaking the SDK stack trace.
  const claudePath = empty ? undefined : findClaudePath();
  const scanners = (!empty && claudePath)
    ? await (async () => {
        log(`  [${projectName}] LLM scanning (oracle + decisions + safety + deploy)...`);
        return Promise.allSettled([
          // Oracle scan
          (async () => {
            if (oracleExists(projectPath)) return { type: "oracle" as const, skipped: true };
            const { runOracleScan } = await import("../agents/scanners/oracle.js");
            return { type: "oracle" as const, result: await runOracleScan({ projectPath, workspaceMode: opts?.workspaceMode }) };
          })(),
          // Decision scan — pass existing decisions (from presets) so scanner skips same-topic
          (async () => {
            const { runDecisionScan } = await import("../agents/scanners/decision.js");
            const existing = listDecisions(projectPath);
            return { type: "decision" as const, result: await runDecisionScan({ projectPath, existingDecisions: existing }) };
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
      })()
    : [];
  if (empty) {
    log(`  [${projectName}] Project appears empty (< ${EMPTY_PROJECT_THRESHOLD} non-trivial files outside .git/node_modules/etc) — skipping LLM scanners, writing presets + deterministic oracle only. Re-run with --force after adding code to get an LLM scan.`);
  } else if (!claudePath) {
    log(`  [${projectName}] Claude Code CLI not found on PATH — skipping LLM scanners (install with: npm install -g @anthropic-ai/claude-code)`);
    errors.push("Claude Code CLI not installed — LLM scanners skipped, using deterministic fallback");
  }

  // Process results
  log(`  [${projectName}] Scanners complete, processing results...`);
  // Telemetry counters: how many of the 4 scanners actually ran (non-skipped)
  // and how many failed (rejected). Used by setup_complete telemetry payload.
  let scannersRun = 0;
  let scannersFailed = 0;
  for (const settled of scanners) {
    if (settled.status === "rejected") {
      scannersFailed++;
      scannersRun++;
      const err = settled.reason;
      const msg = err?.message ?? String(err);
      const stack = err?.stack ? `\n${err.stack.split("\n").slice(0, 3).join("\n")}` : "";
      errors.push(`LLM scan failed: ${msg}${stack}`);
      continue;
    }
    const val = settled.value;
    if ("skipped" in val) continue;
    scannersRun++;

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

  // Remove setup lock
  try { removeFile(lockPath); } catch {}

  return {
    projectPath,
    created: !alreadyExists,
    oracle: { files: oracleFiles, llm: oracleLlm },
    decisions: {
      count: listDecisions(projectPath).length,
      fromScan: listDecisions(projectPath).filter(d => d.source === "init-scan").length,
      fromPresets: listDecisions(projectPath).filter(d => d.source === "preset").length,
    },
    memories: { count: listMemories(projectPath).length, fromPresets: listMemories(projectPath).filter(m => m.source === "preset").length },
    safety: { created: true, llm: safetyLlm, summary: safetySummary },
    config: configCreated,
    cost: totalCost,
    durationMs: Date.now() - startTime,
    errors,
    scannersRun,
    scannersFailed,
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
        name: basename(ws.root),
        type: ws.type,
        manifest: ws.manifestPath,
        projects: ws.projects,
      }, { lineWidth: 120 });
      atomicWrite(join(workspacePath, AXME_CODE_DIR, "workspace.yaml"), wsYaml);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    workspaceResult.errors.push(`Phase 1 workspace init failed: ${msg}`);
    opts?.onProgress?.(`Warning: workspace init failed: ${msg}`);
  }

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
          const name = basename(r.projectPath);
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
            scannersRun: 0,
            scannersFailed: 4,
          });
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    workspaceResult.errors.push(`Phase 2 per-project init failed: ${msg}`);
    opts?.onProgress?.(`Warning: per-project init failed: ${msg}`);
  }

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
    scannersRun: 0, scannersFailed: 0,
  };
}
