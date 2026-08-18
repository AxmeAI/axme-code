/**
 * Config Storage - persisted user preferences in config.yaml.
 *
 * File: .axme-code/config.yaml
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { atomicWrite, pathExists } from "./engine.js";
import type { ProjectConfig } from "../types.js";
import { AXME_CODE_DIR, DEFAULT_PROJECT_CONFIG } from "../types.js";

const CONFIG_FILE = "config.yaml";

export function writeConfig(projectPath: string, config: ProjectConfig): void {
  atomicWrite(configPath(projectPath), formatConfig(config));
}

export function readConfig(projectPath: string): ProjectConfig {
  const path = configPath(projectPath);
  if (!pathExists(path)) return { ...DEFAULT_PROJECT_CONFIG };
  return parseConfig(readFileSync(path, "utf-8"));
}

export function configExists(projectPath: string): boolean {
  return pathExists(configPath(projectPath));
}

export function configPath(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, CONFIG_FILE);
}

function formatConfig(config: ProjectConfig): string {
  return [
    "# AXME Code configuration",
    "",
    "# Default model for agent sessions (architect, engineer, reviewer, tester)",
    `model: ${config.model}`,
    "",
    "# Model for the session auditor (runs at session end to extract memories,",
    "# decisions, safety rules, and handoff from the session transcript)",
    `auditor_model: ${config.auditorModel}`,
    "",
    "# Run reviewer agent after engineer (true/false)",
    `review_enabled: ${config.reviewEnabled}`,
    "",
    "# Applied preset bundles",
    `presets:`,
    ...config.presets.map(p => `  - ${p}`),
    "",
    "# Context-loading mode at session start.",
    "#   full   — every memory and decision body loaded (default; best for KBs <=100 entries)",
    "#   search — only catalog loaded, bodies fetched via axme_get_memory / axme_get_decision /",
    "#            axme_search_kb. Recommended for KBs >100 entries. Requires embeddings runtime,",
    "#            installed by: axme-code config set context.mode search",
    "context:",
    `  mode: ${config.contextMode}`,
    "",
    "# Knowledge-base format contract.",
    "#   excerpt_chars — how many characters of a memory description (or decision body)",
    "#                   the search-mode catalog renders per entry. An entry that fits",
    "#                   inside this budget is shown COMPLETE at session start; a longer",
    "#                   one is cut and its tail is only reachable via axme_get_memory.",
    "#                   Write entries to this number and search mode loses nothing.",
    "#   size_warn      — warn at session start once memories+decisions exceed this count.",
    "catalog:",
    `  excerpt_chars: ${config.catalogExcerptChars}`,
    `  size_warn: ${config.kbSizeWarnThreshold}`,
    "",
  ].join("\n");
}

/** Coerce a config number, falling back when absent, non-numeric, or out of range. */
function readNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Supported range for each numeric KB-format key. */
const NUMERIC_RANGES = {
  catalogExcerptChars: { min: 80, max: 2000 },
  kbSizeWarnThreshold: { min: 10, max: 100000 },
} as const;

/**
 * Clamp a numeric config value to its supported range.
 *
 * Callers clamp BEFORE writing so config.yaml holds the value that is
 * actually in effect. Clamping only on read would leave the file saying
 * `excerpt_chars: 5` while the catalog rendered 80 — and the file is what
 * a human inspects when they want to know the setting.
 */
export function clampConfigNumber(
  key: keyof typeof NUMERIC_RANGES, value: number,
): number {
  const { min, max } = NUMERIC_RANGES[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseConfig(content: string): ProjectConfig {
  const doc = yaml.load(content) as Record<string, any> | null;
  if (!doc || typeof doc !== "object") return { ...DEFAULT_PROJECT_CONFIG };

  let contextMode: "full" | "search" = DEFAULT_PROJECT_CONFIG.contextMode;
  const ctxRaw = doc.context;
  if (ctxRaw && typeof ctxRaw === "object" && (ctxRaw.mode === "full" || ctxRaw.mode === "search")) {
    contextMode = ctxRaw.mode;
  }

  // Clamped rather than trusted: a typo'd excerpt_chars of 2 would silently
  // blank the whole catalog, and one of 100000 would defeat the point of
  // search mode. Both failure modes are invisible until a session start
  // costs 10x what it should.
  const catRaw = doc.catalog;
  const catalogExcerptChars = catRaw && typeof catRaw === "object"
    ? readNumber(catRaw.excerpt_chars, DEFAULT_PROJECT_CONFIG.catalogExcerptChars, 80, 2000)
    : DEFAULT_PROJECT_CONFIG.catalogExcerptChars;
  const kbSizeWarnThreshold = catRaw && typeof catRaw === "object"
    ? readNumber(catRaw.size_warn, DEFAULT_PROJECT_CONFIG.kbSizeWarnThreshold, 10, 100000)
    : DEFAULT_PROJECT_CONFIG.kbSizeWarnThreshold;

  return {
    catalogExcerptChars,
    kbSizeWarnThreshold,
    model: String(doc.model ?? DEFAULT_PROJECT_CONFIG.model),
    auditorModel: String(doc.auditor_model ?? DEFAULT_PROJECT_CONFIG.auditorModel),
    reviewEnabled: doc.review_enabled !== false,
    presets: Array.isArray(doc.presets)
      ? doc.presets.map(String).filter(p => {
          if (!p) return false;
          // Warn on unrecognized preset IDs — typos silently skipped before this fix
          const known = ["essential-safety", "ai-agent-guardrails", "production-ready", "team-collaboration"];
          if (!known.includes(p)) {
            process.stderr.write(`AXME config: unknown preset "${p}" — check spelling in config.yaml\n`);
          }
          return true; // keep all, just warn
        })
      : DEFAULT_PROJECT_CONFIG.presets,
    contextMode,
  };
}
