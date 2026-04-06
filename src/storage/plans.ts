/**
 * Plans Storage - hierarchical plans with steps and acceptance rules.
 *
 * Files:
 *   .axme-code/plans/<id>-<slug>.md
 *   .axme-code/plans/handoff.md
 */

import { readFileSync, readdirSync, unlinkSync } from "node:fs";
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

const HANDOFF_RETENTION = 5; // keep last N handoff files

/**
 * Write enriched handoff. Saves as per-session file (handoff-<short-id>.md)
 * and also overwrites handoff.md (latest, for quick access).
 */
export function writeHandoff(projectPath: string, handoff: SessionHandoff): void {
  ensureDir(plansRoot(projectPath));
  const content = formatHandoff(handoff);
  // Always write latest
  atomicWrite(join(plansRoot(projectPath), "handoff.md"), content);
  // Per-session history file
  if (handoff.sessionId) {
    const shortId = handoff.sessionId.slice(0, 8);
    atomicWrite(join(plansRoot(projectPath), `handoff-${shortId}.md`), content);
    cleanupOldHandoffs(projectPath);
  }
}

function formatHandoff(h: SessionHandoff): string {
  const lines = ["# Session Handoff", ""];
  if (h.date || h.sessionId) {
    const meta: string[] = [];
    if (h.date) meta.push(`Date: ${h.date}`);
    if (h.sessionId) meta.push(`Session: ${h.sessionId.slice(0, 8)}`);
    if (h.source) meta.push(`Source: ${h.source}`);
    lines.push(meta.join(" | "), "");
  }
  lines.push(`Stopped at: ${h.stoppedAt}`, "");
  if (h.summary) {
    lines.push("## Summary", h.summary, "");
  }
  lines.push("## In Progress", h.inProgress, "");
  if (h.prs && h.prs.length > 0) {
    lines.push("## PRs");
    for (const pr of h.prs) lines.push(`- [${pr.status}] ${pr.title} - ${pr.url}`);
    lines.push("");
  }
  if (h.testResults) {
    lines.push("## Test Results", h.testResults, "");
  }
  lines.push("## Blockers", h.blockers || "None", "");
  lines.push("## Next Steps", h.next, "");
  lines.push("## Dirty Branches", h.dirtyBranches || "None");
  return lines.join("\n") + "\n";
}

function cleanupOldHandoffs(projectPath: string): void {
  try {
    const dir = plansRoot(projectPath);
    const files = readdirSync(dir)
      .filter(f => f.startsWith("handoff-") && f.endsWith(".md"))
      .sort()
      .reverse();
    for (const f of files.slice(HANDOFF_RETENTION)) {
      try { unlinkSync(join(dir, f)); } catch {}
    }
  } catch {}
}

/**
 * Read the latest handoff (handoff.md).
 * Parses both enriched and legacy minimal format.
 */
export function readHandoff(projectPath: string): SessionHandoff | null {
  const content = readSafe(join(plansRoot(projectPath), "handoff.md"));
  if (!content || content.trim().length < 10) return null;
  const get = (heading: string): string => {
    const regex = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
    const m = content.match(regex);
    return m ? m[1].trim() : "";
  };
  const stoppedMatch = content.match(/Stopped at: (.+)/);
  const sessionMatch = content.match(/Session: (\S+)/);
  const dateMatch = content.match(/Date: (\S+)/);
  const sourceMatch = content.match(/Source: (\S+)/);
  // Parse PRs if present
  const prsSection = get("PRs");
  const prs: Array<{ url: string; title: string; status: string }> = [];
  if (prsSection) {
    for (const line of prsSection.split("\n")) {
      const m = line.match(/^- \[(\w+)\] (.+?) - (.+)$/);
      if (m) prs.push({ status: m[1], title: m[2], url: m[3] });
    }
  }
  return {
    stoppedAt: stoppedMatch?.[1] ?? "",
    inProgress: get("In Progress"),
    blockers: get("Blockers"),
    next: get("Next Steps"),
    dirtyBranches: get("Dirty Branches"),
    summary: get("Summary") || undefined,
    testResults: get("Test Results") || undefined,
    sessionId: sessionMatch?.[1],
    date: dateMatch?.[1],
    source: (sourceMatch?.[1] as "agent" | "auditor") ?? undefined,
    prs: prs.length > 0 ? prs : undefined,
  };
}

/**
 * Context string for axme_context - shows latest handoff to next session.
 */
export function handoffContext(projectPath: string): string {
  const h = readHandoff(projectPath);
  if (!h) return "";
  const parts = [
    "## Previous Session Handoff",
    "",
  ];
  if (h.date || h.sessionId) {
    parts.push(`*${[h.date, h.sessionId ? `session ${h.sessionId}` : "", h.source ? `(${h.source})` : ""].filter(Boolean).join(", ")}*`, "");
  }
  parts.push(`**Stopped at**: ${h.stoppedAt}`);
  if (h.summary) parts.push("", h.summary);
  if (h.prs && h.prs.length > 0) {
    parts.push("", "**PRs**:");
    for (const pr of h.prs) parts.push(`- [${pr.status}] ${pr.title} - ${pr.url}`);
  }
  if (h.testResults) parts.push("", `**Tests**: ${h.testResults}`);
  parts.push("", `**In progress**: ${h.inProgress}`);
  if (h.blockers && h.blockers !== "None") parts.push(`**Blockers**: ${h.blockers}`);
  parts.push(`**Next steps**: ${h.next}`);
  return parts.join("\n");
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
