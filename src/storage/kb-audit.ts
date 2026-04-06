/**
 * Knowledge Base Audit — periodic deep cleanup of decisions/memories.
 *
 * Tracks a counter of session audits. After N audits, recommends (or
 * auto-runs) a deep KB analysis that finds conflicts, stale entries,
 * and consolidation opportunities.
 *
 * Storage:
 *   .axme-code/kb-audit/counter.json   — { count, lastRunAt }
 *   .axme-code/kb-audit/<date>-report.md — human-readable findings
 */

import { join } from "node:path";
import { readJson, writeJson, atomicWrite, ensureDir, pathExists } from "./engine.js";
import { AXME_CODE_DIR } from "../types.js";

const KB_AUDIT_DIR = "kb-audit";
const COUNTER_FILE = "counter.json";

interface KbAuditCounter {
  /** Number of session audits since last KB audit. */
  count: number;
  /** ISO timestamp of the last KB audit run (null if never). */
  lastRunAt: string | null;
  /** ISO timestamp of the last counter increment. */
  lastIncrementAt: string;
}

function counterPath(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, KB_AUDIT_DIR, COUNTER_FILE);
}

function reportsDir(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, KB_AUDIT_DIR);
}

/**
 * Increment the KB audit counter. Called after each successful session audit.
 * Returns the new count and whether a KB audit is recommended.
 */
export function incrementKbAuditCounter(projectPath: string): {
  count: number;
  recommendAudit: boolean;
} {
  const dir = join(projectPath, AXME_CODE_DIR, KB_AUDIT_DIR);
  ensureDir(dir);

  const existing = readJson<KbAuditCounter>(counterPath(projectPath));
  const counter: KbAuditCounter = existing ?? {
    count: 0,
    lastRunAt: null,
    lastIncrementAt: new Date().toISOString(),
  };

  counter.count++;
  counter.lastIncrementAt = new Date().toISOString();
  writeJson(counterPath(projectPath), counter);

  // Recommend KB audit at 20 sessions, strongly at 50
  const recommendAudit = counter.count >= 20;
  return { count: counter.count, recommendAudit };
}

/**
 * Reset the counter after a KB audit run.
 */
export function resetKbAuditCounter(projectPath: string): void {
  const dir = join(projectPath, AXME_CODE_DIR, KB_AUDIT_DIR);
  ensureDir(dir);

  const counter: KbAuditCounter = {
    count: 0,
    lastRunAt: new Date().toISOString(),
    lastIncrementAt: new Date().toISOString(),
  };
  writeJson(counterPath(projectPath), counter);
}

/**
 * Read current counter state.
 */
export function readKbAuditCounter(projectPath: string): KbAuditCounter | null {
  return readJson<KbAuditCounter>(counterPath(projectPath));
}

/**
 * Write a KB audit report file.
 */
export function writeKbAuditReport(
  projectPath: string,
  report: string,
): string {
  const dir = reportsDir(projectPath);
  ensureDir(dir);
  const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = join(dir, `${date}-report.md`);
  atomicWrite(path, report);
  return path;
}

/**
 * List existing KB audit reports.
 */
export function listKbAuditReports(projectPath: string): string[] {
  const dir = reportsDir(projectPath);
  if (!pathExists(dir)) return [];
  try {
    const { readdirSync } = require("node:fs");
    return readdirSync(dir)
      .filter((f: string) => f.endsWith("-report.md"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
