/**
 * Deploy Gate - pre-deploy checklists for staging and production.
 *
 * Files:
 *   .axme-code/deploy/staging-checklist.yaml
 *   .axme-code/deploy/prod-checklist.yaml
 */

import { join } from "node:path";
import { atomicWrite, readSafe, ensureDir, pathExists } from "./engine.js";
import type { ChecklistItem, DeployChecklist } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

const DEPLOY_DIR = "deploy";

// --- Public API ---

export function initDeployStore(projectPath: string): void {
  ensureDir(deployDir(projectPath));
}

export function writeChecklist(projectPath: string, checklist: DeployChecklist): void {
  ensureDir(deployDir(projectPath));
  const filename = checklist.environment === "staging" ? "staging-checklist.yaml" : "prod-checklist.yaml";
  atomicWrite(join(deployDir(projectPath), filename), formatChecklist(checklist));
}

export function readChecklist(projectPath: string, env: "staging" | "production"): DeployChecklist | null {
  const filename = env === "staging" ? "staging-checklist.yaml" : "prod-checklist.yaml";
  const filePath = join(deployDir(projectPath), filename);
  if (!pathExists(filePath)) return null;
  return parseChecklist(readSafe(filePath), env);
}

export function mergeChecklistItems(existing: DeployChecklist, newItems: ChecklistItem[]): DeployChecklist {
  const existingNames = new Set(existing.items.map(i => i.name.toLowerCase()));
  const toAdd = newItems.filter(i => !existingNames.has(i.name.toLowerCase()));
  return { ...existing, items: [...existing.items, ...toAdd] };
}

export function deployExists(projectPath: string): boolean {
  return pathExists(deployDir(projectPath));
}

export function deployDir(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, DEPLOY_DIR);
}

// showChecklist, runChecklist, ChecklistRunResult removed — 0 usages in codebase.
// Deploy gate will be re-implemented when the deploy pipeline is wired (PR#15+).

export function defaultStagingItems(): ChecklistItem[] {
  return [
    { name: "Unit tests pass", command: "npm test || pytest || go test ./...", expected: "exit 0", required: true },
    { name: "Build succeeds", command: "npm run build || make build", expected: "exit 0", required: true },
    { name: "No secrets in staged files", command: "git diff --cached --name-only | grep -E '\\.(env|pem|key)$' || true", expected: "exit 0", required: true },
  ];
}

export function defaultProdItems(): ChecklistItem[] {
  return [
    { name: "Staging verified", command: "echo 'Confirm staging was verified'", expected: "exit 0", required: true },
    { name: "Unit tests pass", command: "npm test || pytest || go test ./...", expected: "exit 0", required: true },
    { name: "Docker image uses specific tag", command: "grep -r ':latest' Dockerfile docker-compose.yml 2>/dev/null | grep -v '#' || echo 'OK'", expected: "contains:OK", required: true },
    { name: "Rollback plan documented", command: "echo 'Confirm rollback plan is documented'", expected: "exit 0", required: true },
  ];
}

// --- File format ---

function escapeYamlValue(s: string): string {
  if (s.includes('"')) return `'${s.replace(/'/g, "''")}'`;
  return `"${s}"`;
}

function formatChecklist(cl: DeployChecklist): string {
  const lines = [`# ${cl.environment} deploy checklist`, `environment: ${cl.environment}`, "", "items:"];
  for (const item of cl.items) {
    lines.push(`  - name: ${escapeYamlValue(item.name)}`);
    lines.push(`    command: ${escapeYamlValue(item.command)}`);
    lines.push(`    expected: ${escapeYamlValue(item.expected)}`);
    lines.push(`    required: ${item.required}`);
  }
  return lines.join("\n") + "\n";
}

function parseChecklist(content: string, env: "staging" | "production"): DeployChecklist {
  const items: ChecklistItem[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const nameLine = lines[i]?.match(/^\s*- name:\s*(?:"([^"]*)"|'((?:[^']|'')*)')\s*$/);
    if (!nameLine) { i++; continue; }
    const name = nameLine[1] ?? nameLine[2]?.replace(/''/g, "'") ?? "";
    const cmdLine = lines[i + 1]?.match(/^\s*command:\s*(?:"([^"]*)"|'((?:[^']|'')*)')\s*$/);
    const expLine = lines[i + 2]?.match(/^\s*expected:\s*(?:"([^"]*)"|'((?:[^']|'')*)')\s*$/);
    const reqLine = lines[i + 3]?.match(/^\s*required:\s*(true|false)\s*$/);
    if (cmdLine && expLine && reqLine) {
      items.push({
        name,
        command: cmdLine[1] ?? cmdLine[2]?.replace(/''/g, "'") ?? "",
        expected: expLine[1] ?? expLine[2]?.replace(/''/g, "'") ?? "",
        required: reqLine[1] === "true",
      });
      i += 4;
    } else { i++; }
  }
  return { environment: env, items };
}
