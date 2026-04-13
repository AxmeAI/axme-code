#!/usr/bin/env tsx
/**
 * ToolEmu Safety Benchmark Runner
 *
 * Runs all scenarios from scenarios.ts through AXME Code's safety check
 * functions (checkBash, checkGit, checkFilePath) and reports metrics.
 *
 * Usage:
 *   cd benchmarks && npm run bench:toolemu
 *
 * Output:
 *   benchmarks/results/toolemu-YYYY-MM-DD.json
 *   Summary printed to stdout
 *
 * Cost: $0 (rule-based, no LLM calls)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Import safety functions from product code (read-only usage)
import { defaultRules, checkBash, checkGit, checkFilePath } from "../../src/storage/safety.js";
import type { SafetyRules } from "../../src/types.js";

import { ALL_SCENARIOS, DANGEROUS_SCENARIOS, BENIGN_SCENARIOS } from "./scenarios.js";
import type { Scenario } from "./scenarios.js";

// ─── Types ───────────────────────────────────────────────────────────

interface ScenarioResult {
  id: string;
  command: string;
  type: string;
  dangerous: boolean;
  category: string;
  description: string;
  blocked: boolean;
  reason: string | null;
  correct: boolean; // blocked === dangerous
}

interface BenchmarkResults {
  timestamp: string;
  version: string;
  totalScenarios: number;
  dangerousCount: number;
  benignCount: number;
  metrics: {
    truePositives: number;   // dangerous + blocked
    falsePositives: number;  // benign + blocked
    trueNegatives: number;   // benign + allowed
    falseNegatives: number;  // dangerous + allowed
    precision: number;
    recall: number;
    f1: number;
    accuracy: number;
    falsePositiveRate: number;
  };
  byCategory: Record<string, {
    total: number;
    correct: number;
    accuracy: number;
  }>;
  scenarios: ScenarioResult[];
}

// ─── Runner ──────────────────────────────────────────────────────────

function runScenario(rules: SafetyRules, scenario: Scenario): ScenarioResult {
  let blocked = false;
  let reason: string | null = null;

  try {
    if (scenario.type === "bash") {
      const verdict = checkBash(rules, scenario.command);
      blocked = !verdict.allowed;
      reason = verdict.allowed ? null : verdict.reason;
    } else if (scenario.type === "git") {
      const verdict = checkGit(rules, scenario.command, undefined, true);
      blocked = !verdict.allowed;
      reason = verdict.allowed ? null : verdict.reason;
    } else if (scenario.type === "filepath") {
      const op = scenario.operation ?? "read";
      const verdict = checkFilePath(rules, scenario.command, op);
      blocked = !verdict.allowed;
      reason = verdict.allowed ? null : verdict.reason;
    }
  } catch (err) {
    // If safety check throws, treat as blocked (fail-safe)
    blocked = true;
    reason = `Exception: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    id: scenario.id,
    command: scenario.command,
    type: scenario.type,
    dangerous: scenario.dangerous,
    category: scenario.category,
    description: scenario.description,
    blocked,
    reason,
    correct: blocked === scenario.dangerous,
  };
}

// ─── Main ────────────────────────────────────────────────────────────

function main() {
  console.log("▶ AXME Code Safety Benchmark (ToolEmu-inspired)");
  console.log(`  ${DANGEROUS_SCENARIOS.length} dangerous + ${BENIGN_SCENARIOS.length} benign = ${ALL_SCENARIOS.length} scenarios`);
  console.log();

  const rules = defaultRules();
  const results: ScenarioResult[] = ALL_SCENARIOS.map(s => runScenario(rules, s));

  // Compute metrics
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of results) {
    if (r.dangerous && r.blocked) tp++;
    else if (r.dangerous && !r.blocked) fn++;
    else if (!r.dangerous && r.blocked) fp++;
    else tn++;
  }

  const precision = tp / (tp + fp) || 0;
  const recall = tp / (tp + fn) || 0;
  const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
  const accuracy = (tp + tn) / results.length;
  const fpr = fp / (fp + tn) || 0;

  // By category
  const byCategory: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { total: 0, correct: 0, accuracy: 0 };
    byCategory[r.category].total++;
    if (r.correct) byCategory[r.category].correct++;
  }
  for (const cat of Object.values(byCategory)) {
    cat.accuracy = cat.correct / cat.total;
  }

  const output: BenchmarkResults = {
    timestamp: new Date().toISOString(),
    version: "0.2.7",
    totalScenarios: results.length,
    dangerousCount: DANGEROUS_SCENARIOS.length,
    benignCount: BENIGN_SCENARIOS.length,
    metrics: {
      truePositives: tp,
      falsePositives: fp,
      trueNegatives: tn,
      falseNegatives: fn,
      precision: Math.round(precision * 10000) / 10000,
      recall: Math.round(recall * 10000) / 10000,
      f1: Math.round(f1 * 10000) / 10000,
      accuracy: Math.round(accuracy * 10000) / 10000,
      falsePositiveRate: Math.round(fpr * 10000) / 10000,
    },
    byCategory,
    scenarios: results,
  };

  // Print summary
  console.log("═══ Results ═══");
  console.log();
  console.log(`  True Positives  (dangerous, blocked):  ${tp}/${DANGEROUS_SCENARIOS.length}`);
  console.log(`  False Negatives (dangerous, allowed):  ${fn}/${DANGEROUS_SCENARIOS.length}`);
  console.log(`  True Negatives  (benign, allowed):     ${tn}/${BENIGN_SCENARIOS.length}`);
  console.log(`  False Positives (benign, blocked):     ${fp}/${BENIGN_SCENARIOS.length}`);
  console.log();
  console.log(`  Precision:          ${(precision * 100).toFixed(1)}%`);
  console.log(`  Recall (TPR):       ${(recall * 100).toFixed(1)}%`);
  console.log(`  F1 Score:           ${(f1 * 100).toFixed(1)}%`);
  console.log(`  Accuracy:           ${(accuracy * 100).toFixed(1)}%`);
  console.log(`  False Positive Rate: ${(fpr * 100).toFixed(1)}%`);
  console.log();

  // Print failures
  const failures = results.filter(r => !r.correct);
  if (failures.length > 0) {
    console.log("═══ Failures ═══");
    console.log();
    for (const f of failures) {
      const action = f.blocked ? "BLOCKED (should be allowed)" : "ALLOWED (should be blocked)";
      console.log(`  ${f.id}: ${action}`);
      console.log(`    Command:  ${f.command}`);
      console.log(`    Category: ${f.category}`);
      console.log(`    ${f.description}`);
      if (f.reason) console.log(`    Reason:   ${f.reason}`);
      console.log();
    }
  } else {
    console.log("  ✓ All scenarios correct — zero failures");
    console.log();
  }

  // Print by category
  console.log("═══ By Category ═══");
  console.log();
  for (const [cat, stats] of Object.entries(byCategory).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = (stats.accuracy * 100).toFixed(0);
    const mark = stats.accuracy === 1 ? "✓" : "✗";
    console.log(`  ${mark} ${cat.padEnd(25)} ${stats.correct}/${stats.total} (${pct}%)`);
  }
  console.log();

  // Write results
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const resultsDir = join(__dirname, "..", "results");
  mkdirSync(resultsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = join(resultsDir, `toolemu-${date}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`  Results written to: ${outPath}`);
}

main();
