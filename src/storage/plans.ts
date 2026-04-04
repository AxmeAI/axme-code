/**
 * Plans Storage - hierarchical plans with steps and acceptance rules.
 *
 * Files:
 *   .axme-code/plans/<id>-<slug>.md
 *   .axme-code/plans/handoff.md
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite, readSafe, ensureDir, pathExists } from "./engine.js";
import type { Plan, PlanStep, PlanStatus, StepStatus, AcceptanceRule, SessionHandoff } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

const PLANS_DIR = "plans";

function plansRoot(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, PLANS_DIR);
}

export function initPlanStore(projectPath: string): void {
  ensureDir(plansRoot(projectPath));
}

export function plansExist(projectPath: string): boolean {
  return pathExists(plansRoot(projectPath));
}

export function plansDir(projectPath: string): string {
  return plansRoot(projectPath);
}

export function createPlan(projectPath: string, title: string, steps: string[], opts?: {
  acceptanceRule?: AcceptanceRule; parentId?: string | null;
}): Plan {
  initPlanStore(projectPath);
  const now = new Date().toISOString();
  const plan: Plan = {
    id: randomUUID().slice(0, 8),
    slug: toSlug(title),
    title,
    parentId: opts?.parentId ?? null,
    status: "active",
    acceptanceRule: opts?.acceptanceRule ?? "auto",
    steps: steps.map(text => ({ text, status: "pending" as StepStatus, subPlanId: null })),
    created: now,
    updated: now,
  };
  savePlan(projectPath, plan);
  return plan;
}

export function savePlan(projectPath: string, plan: Plan): void {
  ensureDir(plansRoot(projectPath));
  plan.updated = new Date().toISOString();
  atomicWrite(join(plansRoot(projectPath), planFilename(plan.id, plan.slug)), formatPlanFile(plan));
}

export function listPlans(projectPath: string, opts?: { status?: PlanStatus }): Plan[] {
  const dir = plansRoot(projectPath);
  if (!pathExists(dir)) return [];
  const plans: Plan[] = [];
  try {
    for (const f of readdirSync(dir).filter(f => f.endsWith(".md") && f !== "handoff.md").sort()) {
      const plan = parsePlanFile(readSafe(join(dir, f)));
      if (plan) {
        if (opts?.status && plan.status !== opts.status) continue;
        plans.push(plan);
      }
    }
  } catch {}
  return plans;
}

export function getPlan(projectPath: string, id: string): Plan | null {
  return listPlans(projectPath).find(p => p.id === id || p.slug === id) ?? null;
}

export function getActivePlans(projectPath: string): Plan[] {
  return listPlans(projectPath, { status: "active" });
}

export function markStepDone(projectPath: string, planId: string, stepIndex: number): void {
  const plan = getPlan(projectPath, planId);
  if (!plan || stepIndex >= plan.steps.length) return;
  plan.steps[stepIndex].status = "done";
  if (plan.steps.every(s => s.status === "done" || s.status === "skipped")) {
    plan.status = "completed";
  }
  savePlan(projectPath, plan);
}

export function markStepInProgress(projectPath: string, planId: string, stepIndex: number): void {
  const plan = getPlan(projectPath, planId);
  if (!plan || stepIndex >= plan.steps.length) return;
  plan.steps[stepIndex].status = "in-progress";
  savePlan(projectPath, plan);
}

export function getNextStep(plan: Plan): { index: number; step: PlanStep } | null {
  const idx = plan.steps.findIndex(s => s.status === "pending");
  if (idx === -1) return null;
  return { index: idx, step: plan.steps[idx] };
}

export function plansContext(projectPath: string): string {
  const active = getActivePlans(projectPath);
  if (active.length === 0) return "";
  const parts: string[] = ["## Active Plans"];
  for (const plan of active) {
    const done = plan.steps.filter(s => s.status === "done").length;
    const total = plan.steps.length;
    parts.push(`\n### ${plan.title} (${done}/${total})`);
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      const mark = s.status === "done" ? "x" : s.status === "in-progress" ? ">" : s.status === "skipped" ? "-" : " ";
      parts.push(`  [${mark}] ${s.text}`);
    }
  }
  return parts.join("\n");
}

export function showPlans(projectPath: string): string {
  const plans = listPlans(projectPath);
  if (plans.length === 0) return "No plans.";
  return plans.map(p => {
    const done = p.steps.filter(s => s.status === "done").length;
    return `[${p.status}] ${p.id}: ${p.title} (${done}/${p.steps.length} steps)`;
  }).join("\n");
}

export function showPlan(projectPath: string, id: string): string {
  const plan = getPlan(projectPath, id);
  if (!plan) return `Plan '${id}' not found.`;
  const lines = [`# ${plan.title}`, `Status: ${plan.status}`, `Acceptance: ${plan.acceptanceRule}`, ""];
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    const mark = s.status === "done" ? "x" : s.status === "in-progress" ? ">" : s.status === "skipped" ? "-" : " ";
    lines.push(`${i + 1}. [${mark}] ${s.text}`);
  }
  return lines.join("\n");
}

// --- Handoff ---

export function writeHandoff(projectPath: string, handoff: SessionHandoff): void {
  ensureDir(plansRoot(projectPath));
  const lines = [
    "# Session Handoff", "",
    `Stopped at: ${handoff.stoppedAt}`, "",
    "## In Progress", handoff.inProgress, "",
    "## Blockers", handoff.blockers, "",
    "## Next Steps", handoff.next, "",
    "## Dirty Branches", handoff.dirtyBranches,
  ];
  atomicWrite(join(plansRoot(projectPath), "handoff.md"), lines.join("\n") + "\n");
}

export function readHandoff(projectPath: string): SessionHandoff | null {
  const content = readSafe(join(plansRoot(projectPath), "handoff.md"));
  if (!content) return null;
  const get = (heading: string): string => {
    const regex = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
    const m = content.match(regex);
    return m ? m[1].trim() : "";
  };
  const stoppedMatch = content.match(/Stopped at: (.+)/);
  return {
    stoppedAt: stoppedMatch?.[1] ?? "",
    inProgress: get("In Progress"),
    blockers: get("Blockers"),
    next: get("Next Steps"),
    dirtyBranches: get("Dirty Branches"),
  };
}

export function handoffContext(projectPath: string): string {
  const h = readHandoff(projectPath);
  if (!h) return "";
  return `## Previous Session Handoff\n\nStopped: ${h.stoppedAt}\nIn progress: ${h.inProgress}\nBlockers: ${h.blockers}\nNext: ${h.next}`;
}

// --- File format ---

function planFilename(id: string, slug: string): string {
  return `${id}-${slug}.md`;
}

function formatPlanFile(plan: Plan): string {
  const lines = [
    "---",
    `id: ${plan.id}`,
    `slug: ${plan.slug}`,
    `title: ${plan.title}`,
    `parentId: ${plan.parentId ?? ""}`,
    `status: ${plan.status}`,
    `acceptanceRule: ${plan.acceptanceRule}`,
    `created: ${plan.created}`,
    `updated: ${plan.updated}`,
    "---",
    "",
    `# ${plan.title}`,
    "",
  ];
  for (const s of plan.steps) {
    const mark = s.status === "done" ? "x" : s.status === "in-progress" ? ">" : s.status === "skipped" ? "-" : " ";
    lines.push(`- [${mark}] ${s.text}${s.subPlanId ? ` (sub: ${s.subPlanId})` : ""}`);
  }
  return lines.join("\n") + "\n";
}

function parsePlanFile(content: string): Plan | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const body = fmMatch[2];

  const get = (key: string): string => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };

  const id = get("id");
  const title = get("title");
  if (!id || !title) return null;

  const steps: PlanStep[] = [];
  const stepRegex = /^- \[([x> -])\] (.+?)(?:\s*\(sub: ([^)]+)\))?$/gm;
  let match;
  while ((match = stepRegex.exec(body)) !== null) {
    const mark = match[1];
    const status: StepStatus = mark === "x" ? "done" : mark === ">" ? "in-progress" : mark === "-" ? "skipped" : "pending";
    steps.push({ text: match[2].trim(), status, subPlanId: match[3] ?? null });
  }

  return {
    id,
    slug: get("slug"),
    title,
    parentId: get("parentId") || null,
    status: (get("status") || "active") as PlanStatus,
    acceptanceRule: (get("acceptanceRule") || "auto") as AcceptanceRule,
    steps,
    created: get("created"),
    updated: get("updated"),
  };
}

function toSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}
