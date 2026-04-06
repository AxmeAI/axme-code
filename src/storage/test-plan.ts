/**
 * Test Plan Storage - persistent test definitions for tester agent.
 *
 * File: .axme-code/test-plan.yaml
 * Sections: auto (always run), e2e (per config), custom (user-added)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readSafe, pathExists } from "./engine.js";
import type { TestItem, E2ETestItem, TestPlan } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

const TEST_PLAN_FILE = "test-plan.yaml";

export function testPlanPath(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, TEST_PLAN_FILE);
}

export function testPlanExists(projectPath: string): boolean {
  return pathExists(testPlanPath(projectPath));
}

export function readTestPlan(projectPath: string): TestPlan {
  const path = testPlanPath(projectPath);
  if (!pathExists(path)) return { auto: [], e2e: [], custom: [] };
  return parseTestPlan(readSafe(path));
}

export function writeTestPlan(projectPath: string, plan: TestPlan): void {
  atomicWrite(testPlanPath(projectPath), formatTestPlan(plan));
}

export function addAutoTest(projectPath: string, item: TestItem): void {
  const plan = readTestPlan(projectPath);
  if (!plan.auto.some(t => t.name === item.name)) {
    plan.auto.push(item);
    writeTestPlan(projectPath, plan);
  }
}

export function addE2ETest(projectPath: string, item: E2ETestItem): void {
  const plan = readTestPlan(projectPath);
  if (!plan.e2e.some(t => t.name === item.name)) {
    plan.e2e.push(item);
    writeTestPlan(projectPath, plan);
  }
}

export function addCustomTest(projectPath: string, item: TestItem): void {
  const plan = readTestPlan(projectPath);
  if (!plan.custom.some(t => t.name === item.name)) {
    plan.custom.push(item);
    writeTestPlan(projectPath, plan);
  }
}

export function removeTest(projectPath: string, name: string): boolean {
  const plan = readTestPlan(projectPath);
  const before = plan.auto.length + plan.e2e.length + plan.custom.length;
  plan.auto = plan.auto.filter(t => t.name !== name);
  plan.e2e = plan.e2e.filter(t => t.name !== name);
  plan.custom = plan.custom.filter(t => t.name !== name);
  const after = plan.auto.length + plan.e2e.length + plan.custom.length;
  if (after < before) { writeTestPlan(projectPath, plan); return true; }
  return false;
}

/**
 * Generate initial test plan from project detection.
 */
export function generateTestPlan(projectPath: string): TestPlan {
  const plan: TestPlan = { auto: [], e2e: [], custom: [] };

  const pkgPath = join(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.test) plan.auto.push({ name: "Unit tests", command: "npm test", expected: "exit 0", required: true });
      if (scripts.lint) plan.auto.push({ name: "Lint", command: "npm run lint", expected: "exit 0", required: true });
      if (scripts.build) plan.auto.push({ name: "Build", command: "npm run build", expected: "exit 0", required: true });
      if (scripts.typecheck || scripts["type-check"]) {
        plan.auto.push({ name: "Type check", command: scripts.typecheck ? "npm run typecheck" : "npm run type-check", expected: "exit 0", required: true });
      }
    } catch {}
  }

  if (existsSync(join(projectPath, "tsconfig.json")) && !plan.auto.some(t => t.name === "Type check")) {
    plan.auto.push({ name: "Type check", command: "npx tsc --noEmit", expected: "exit 0", required: true });
  }

  const hasPython = existsSync(join(projectPath, "pyproject.toml"))
    || existsSync(join(projectPath, "setup.py"))
    || existsSync(join(projectPath, "requirements.txt"));
  if (hasPython) {
    if (existsSync(join(projectPath, "tests")) || existsSync(join(projectPath, "test"))) {
      plan.auto.push({ name: "Python tests", command: "python -m pytest", expected: "exit 0", required: true });
    }
  }

  if (existsSync(join(projectPath, "go.mod"))) {
    plan.auto.push({ name: "Go tests", command: "go test ./...", expected: "exit 0", required: true });
    plan.auto.push({ name: "Go vet", command: "go vet ./...", expected: "exit 0", required: true });
  }

  if (existsSync(join(projectPath, "Makefile"))) {
    try {
      const content = readFileSync(join(projectPath, "Makefile"), "utf-8");
      if (content.includes("test:") && !plan.auto.some(t => t.command.startsWith("make test"))) {
        plan.auto.push({ name: "Make test", command: "make test", expected: "exit 0", required: true });
      }
    } catch {}
  }

  return plan;
}

export function testPlanContext(projectPath: string): string {
  const plan = readTestPlan(projectPath);
  if (plan.auto.length === 0 && plan.e2e.length === 0 && plan.custom.length === 0) return "";

  const parts: string[] = ["## Test Plan"];
  if (plan.auto.length > 0) {
    parts.push("\n### Auto tests (always run):");
    for (const t of plan.auto) parts.push(`- **${t.name}**${t.required ? " [required]" : ""}: \`${t.command}\``);
  }
  if (plan.e2e.length > 0) {
    parts.push("\n### E2E tests:");
    for (const t of plan.e2e) {
      if (t.manual) parts.push(`- **${t.name}** [manual]: ${t.instructions ?? t.command}`);
      else parts.push(`- **${t.name}**${t.required ? " [required]" : ""}: \`${t.command}\``);
    }
  }
  if (plan.custom.length > 0) {
    parts.push("\n### Custom checks:");
    for (const t of plan.custom) parts.push(`- **${t.name}**: \`${t.command}\``);
  }
  return parts.join("\n");
}

export function showTestPlan(projectPath: string): string {
  const plan = readTestPlan(projectPath);
  const total = plan.auto.length + plan.e2e.length + plan.custom.length;
  if (total === 0) return "No test plan.";

  const lines: string[] = [`Test Plan (${total} tests)`];
  if (plan.auto.length > 0) {
    lines.push(`\n  Auto (${plan.auto.length}):`);
    for (const t of plan.auto) lines.push(`    ${t.required ? "[req]" : "[opt]"} ${t.name}: ${t.command}`);
  }
  if (plan.e2e.length > 0) {
    lines.push(`\n  E2E (${plan.e2e.length}):`);
    for (const t of plan.e2e) lines.push(`    ${t.manual ? "[manual]" : t.required ? "[req]" : "[opt]"} ${t.name}: ${t.manual ? t.instructions ?? "" : t.command}`);
  }
  if (plan.custom.length > 0) {
    lines.push(`\n  Custom (${plan.custom.length}):`);
    for (const t of plan.custom) lines.push(`    ${t.name}: ${t.command}`);
  }
  return lines.join("\n");
}

// --- YAML format ---

function yamlStr(val: string): string {
  if (val.includes(":") || val.includes("#") || val.includes("'") || val.includes('"') || val.startsWith(" ")) {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return val;
}

function formatTestPlan(plan: TestPlan): string {
  const lines: string[] = ["# AXME Code Test Plan", ""];
  lines.push("auto:");
  if (plan.auto.length === 0) { lines.push("  []"); }
  else { for (const t of plan.auto) { lines.push(`  - name: ${yamlStr(t.name)}`, `    command: ${yamlStr(t.command)}`, `    expected: ${yamlStr(t.expected)}`, `    required: ${t.required}`); } }

  lines.push("", "e2e:");
  if (plan.e2e.length === 0) { lines.push("  []"); }
  else { for (const t of plan.e2e) { lines.push(`  - name: ${yamlStr(t.name)}`, `    command: ${yamlStr(t.command)}`, `    expected: ${yamlStr(t.expected)}`, `    required: ${t.required}`, `    manual: ${t.manual}`); if (t.instructions) lines.push(`    instructions: ${yamlStr(t.instructions)}`); } }

  lines.push("", "custom:");
  if (plan.custom.length === 0) { lines.push("  []"); }
  else { for (const t of plan.custom) { lines.push(`  - name: ${yamlStr(t.name)}`, `    command: ${yamlStr(t.command)}`, `    expected: ${yamlStr(t.expected)}`, `    required: ${t.required}`); } }

  return lines.join("\n") + "\n";
}

function parseTestPlan(content: string): TestPlan {
  const plan: TestPlan = { auto: [], e2e: [], custom: [] };
  let currentSection: "auto" | "e2e" | "custom" | null = null;
  let currentItem: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed === "" || trimmed === "[]") continue;
    if (trimmed === "auto:") { flushItem(plan, currentSection, currentItem); currentSection = "auto"; currentItem = {}; continue; }
    if (trimmed === "e2e:") { flushItem(plan, currentSection, currentItem); currentSection = "e2e"; currentItem = {}; continue; }
    if (trimmed === "custom:") { flushItem(plan, currentSection, currentItem); currentSection = "custom"; currentItem = {}; continue; }
    if (!currentSection) continue;
    if (trimmed.startsWith("- name:")) { flushItem(plan, currentSection, currentItem); currentItem = { name: parseYamlValue(trimmed.slice(7)) }; continue; }
    // Split on FIRST colon only. Previous indexOf(":") would break on values
    // containing colons (e.g. command: curl http://host:8080). We look for the
    // first unquoted colon that is preceded by a YAML key (word chars only).
    const keyMatch = trimmed.match(/^(\w+):\s*(.*)/);
    if (keyMatch) { currentItem[keyMatch[1]] = parseYamlValue(keyMatch[2]); }
  }
  flushItem(plan, currentSection, currentItem);
  return plan;
}

function flushItem(plan: TestPlan, section: "auto" | "e2e" | "custom" | null, item: Record<string, string>): void {
  if (!section || !item.name) return;
  const base: TestItem = { name: item.name, command: item.command ?? "", expected: item.expected ?? "exit 0", required: item.required !== "false" };
  if (section === "e2e") {
    plan.e2e.push({ ...base, manual: item.manual === "true", instructions: item.instructions });
  } else { plan[section].push(base); }
  for (const key of Object.keys(item)) delete item[key];
}

function parseYamlValue(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}
