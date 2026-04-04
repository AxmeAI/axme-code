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
    "# Default model for agent sessions",
    `model: ${config.model}`,
    "",
    "# Run reviewer agent after engineer (true/false)",
    `review_enabled: ${config.reviewEnabled}`,
    "",
    "# Applied preset bundles",
    `presets:`,
    ...config.presets.map(p => `  - ${p}`),
    "",
  ].join("\n");
}

function parseConfig(content: string): ProjectConfig {
  const doc = yaml.load(content) as Record<string, any> | null;
  if (!doc || typeof doc !== "object") return { ...DEFAULT_PROJECT_CONFIG };

  return {
    model: String(doc.model ?? DEFAULT_PROJECT_CONFIG.model),
    reviewEnabled: doc.review_enabled !== false,
    presets: Array.isArray(doc.presets) ? doc.presets.map(String) : DEFAULT_PROJECT_CONFIG.presets,
  };
}
