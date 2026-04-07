/**
 * Decision Log - architectural decisions with enforce levels.
 *
 * Files:
 *   .axme-code/decisions/index.md          summary
 *   .axme-code/decisions/D-001-<slug>.md   individual records
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite, ensureDir, pathExists } from "./engine.js";
import { logDecisionSaved, logDecisionSuperseded } from "./worklog.js";
import type { Decision } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

const DECISIONS_DIR = "decisions";

// --- Public API ---

export function initDecisionStore(projectPath: string): void {
  ensureDir(decisionsDir(projectPath));
}

export function saveDecisions(projectPath: string, decisions: Decision[]): void {
  const dir = decisionsDir(projectPath);
  ensureDir(dir);

  const existing = listDecisions(projectPath);
  const deduped = deduplicateDecisions(decisions, existing);

  for (const d of deduped) {
    atomicWrite(join(dir, `${d.id}-${d.slug}.md`), formatDecisionFile(d));
  }
  rebuildIndex(projectPath);
}

/**
 * Add a new decision to the project's decision log.
 *
 * Two guarantees against duplication and data corruption under parallel writes:
 *
 * 1. Title-based dedup. Before allocating a new id we check if a decision with
 *    a semantically equivalent title (via normalizeTitle) already exists. If
 *    yes, we return that existing decision unchanged. This prevents the
 *    "auditor re-extracted the same rule on a resumed session" scenario from
 *    polluting storage, and is the fix for the silent bypass of the
 *    deduplicateDecisions helper that lived in this file but was never wired
 *    into the saveScopedDecisions → addDecision write path.
 *
 * 2. Atomic id allocation via O_EXCL. Two parallel addDecision calls (two
 *    audit workers, two windows closing simultaneously) would otherwise both
 *    read the same "max id" and both write D-NNN with the same number but
 *    different slug suffixes. We use writeFileSync with `flag: "wx"` which
 *    maps to O_CREAT|O_EXCL at the POSIX level — the first writer wins, the
 *    second gets EEXIST and bumps the number. Bounded retry loop (50 attempts)
 *    is far more than any realistic race window.
 */
export function addDecision(projectPath: string, input: Omit<Decision, "id">): Decision {
  const dir = decisionsDir(projectPath);
  ensureDir(dir);

  // (1) Title-based dedup. If an existing decision has an equivalent title,
  // return it as-is. saveScopedDecisions callers treat this as success.
  const existing = listDecisions(projectPath);
  const normTarget = normalizeTitle(input.title);
  if (normTarget) {
    const match = existing.find(d => normalizeTitle(d.title) === normTarget);
    if (match) return match;
  }

  // (2) Atomic id allocation with O_EXCL retry. Start at max(existing)+1 and
  // bump on each EEXIST collision.
  let nextNum = existing.length > 0
    ? Math.max(...existing.map(d => parseInt(d.id.replace("D-", ""), 10))) + 1
    : 1;

  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `D-${String(nextNum).padStart(3, "0")}`;
    const filePath = join(dir, `${id}-${input.slug}.md`);
    const decision: Decision = { id, ...input };
    try {
      // flag: "wx" = O_CREAT | O_EXCL — atomic, fails if file already exists.
      writeFileSync(filePath, formatDecisionFile(decision), { flag: "wx", encoding: "utf-8" });
      rebuildIndex(projectPath);
      try { logDecisionSaved(projectPath, input.sessionId ?? "", id, input.title, input.source ?? "agent"); } catch {}
      return decision;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      // Another process allocated this id between our listDecisions() and
      // our write. Try the next number.
      nextNum++;
    }
  }
  throw new Error(`addDecision: could not allocate D-NNN id after 50 attempts for "${input.title}"`);
}

/**
 * List decisions, defaulting to only active ones.
 * Pass `{ includeAll: true }` to include superseded/deprecated/revoked.
 * Decisions without a `status` field are treated as active (backward compat).
 */
export function listDecisions(projectPath: string, opts?: { includeAll?: boolean }): Decision[] {
  const dir = decisionsDir(projectPath);
  if (!pathExists(dir)) return [];

  const files = listDecisionFiles(dir);
  const all = files.map(f => parseDecisionFile(join(dir, f))).filter((d): d is Decision => d !== null);
  if (opts?.includeAll) return all;
  return all.filter(d => !d.status || d.status === "active");
}

/**
 * Supersede an existing decision with a new one. The old decision gets
 * status=superseded + supersededBy=newId, and the new decision gets
 * supersedes=[oldId]. Returns both for caller inspection.
 */
export function supersedeDecision(
  projectPath: string,
  oldIdOrSlug: string,
  newInput: Omit<Decision, "id" | "supersedes">,
): { oldDecision: Decision; newDecision: Decision } {
  const old = getDecision(projectPath, oldIdOrSlug);
  if (!old) throw new Error(`Decision ${oldIdOrSlug} not found`);

  // Create the replacement decision
  const newDecision = addDecision(projectPath, {
    ...newInput,
    supersedes: [old.id],
  });

  // Mark the old one as superseded
  old.status = "superseded";
  old.supersededBy = newDecision.id;
  const dir = decisionsDir(projectPath);
  atomicWrite(join(dir, `${old.id}-${old.slug}.md`), formatDecisionFile(old));
  rebuildIndex(projectPath);
  try { logDecisionSuperseded(projectPath, newInput.sessionId ?? "", old.id, newDecision.id); } catch {}

  return { oldDecision: old, newDecision };
}

/**
 * Revoke a decision without replacement (e.g. rule no longer applies).
 */
export function revokeDecision(
  projectPath: string,
  idOrSlug: string,
  reason: string,
): Decision {
  const d = getDecision(projectPath, idOrSlug);
  if (!d) throw new Error(`Decision ${idOrSlug} not found`);

  d.status = "revoked";
  d.revokedAt = new Date().toISOString();
  d.revokedReason = reason;
  const dir = decisionsDir(projectPath);
  atomicWrite(join(dir, `${d.id}-${d.slug}.md`), formatDecisionFile(d));
  rebuildIndex(projectPath);

  return d;
}

export function getDecision(projectPath: string, idOrSlug: string): Decision | null {
  return listDecisions(projectPath).find(d =>
    d.id === idOrSlug || d.slug === idOrSlug || d.id.toLowerCase() === idOrSlug.toLowerCase()
  ) ?? null;
}

export function decisionsExist(projectPath: string): boolean {
  return pathExists(decisionsDir(projectPath));
}

export function decisionsDir(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, DECISIONS_DIR);
}

export function decisionsContext(projectPath: string): string {
  const decisions = listDecisions(projectPath);
  if (decisions.length === 0) return "";
  const lines = decisions.map(d => `- **${d.id}: ${d.title}** [${d.enforce ?? "info"}] (${d.date}) - ${d.decision}`);
  return [
    "## Project Decisions",
    "If two active decisions contradict each other, treat the NEWER one (by date) as authoritative. The older one is a candidate for supersede at next audit.",
    ...lines,
  ].join("\n");
}

export function enforceableDecisionsContext(projectPath: string): string {
  const decisions = listDecisions(projectPath);
  const required = decisions.filter(d => d.enforce === "required");
  const advisory = decisions.filter(d => d.enforce === "advisory");
  if (required.length === 0 && advisory.length === 0) return "";

  const parts: string[] = ["## Enforceable Rules"];
  if (required.length > 0) {
    parts.push("\n### Required (MUST flag violations):");
    for (const d of required) parts.push(`- **${d.title}**: ${d.decision}`);
  }
  if (advisory.length > 0) {
    parts.push("\n### Advisory (warn but don't block):");
    for (const d of advisory) parts.push(`- ${d.title}: ${d.decision}`);
  }
  return parts.join("\n");
}

/**
 * Save decisions with scope-based routing. Accepts decisions WITHOUT an id —
 * each target path generates its own sequential id independently (so repo A
 * and repo B can both have D-042 pointing to different decisions).
 *
 * Routing:
 * - No scope / empty scope / ["all"] → session origin (projectPath). If a
 *   workspacePath is provided, "all" means workspace root so the rule is
 *   discoverable workspace-wide.
 * - [repoName] / [repoName, ...] → each listed repo inside the workspace.
 */
export function saveScopedDecisions(
  decisions: Array<Omit<Decision, "id">>, projectPath: string, workspacePath?: string,
): { saved: number; crossProject: number } {
  let saved = 0, crossProject = 0;
  const projectName = projectPath.split("/").pop() ?? "";

  for (const d of decisions) {
    const scope = d.scope;
    const isAllScope = !scope || scope.length === 0 || (scope.length === 1 && scope[0] === "all");
    const isSelfScope = scope && scope.length === 1 && scope[0] === projectName;

    if (isAllScope) {
      // "all" scope goes to the session origin. In a workspace session that's
      // the workspace root (discoverable by any repo); in a single-repo session
      // it's that repo's .axme-code/.
      addDecision(projectPath, d);
      saved++;
    } else if (isSelfScope) {
      addDecision(projectPath, d);
      saved++;
    } else if (workspacePath) {
      // Write to each listed repo. Do NOT write a copy to workspace root — the
      // rule is repo-specific, not universal.
      let writtenToRepo = false;
      for (const target of scope!) {
        if (target === "all") continue;
        const targetPath = resolve(workspacePath, target);
        if (pathExists(join(targetPath, ".axme-code")) || pathExists(join(targetPath, ".git"))) {
          addDecision(targetPath, d);
          writtenToRepo = true;
          crossProject++;
        }
      }
      // Fallback: if none of the listed repos exist, write to workspace root
      // so the rule isn't silently dropped.
      if (!writtenToRepo) addDecision(workspacePath, d);
      saved++;
    } else {
      addDecision(projectPath, d);
      saved++;
    }
  }
  return { saved, crossProject };
}

export function listScopedDecisions(projectPath: string, workspacePath?: string): Decision[] {
  const projectDecisions = listDecisions(projectPath);
  if (!workspacePath || workspacePath === projectPath) return projectDecisions;

  const projectName = projectPath.split("/").pop() ?? "";
  const wsDecisions = listDecisions(workspacePath);
  const relevantWs = wsDecisions.filter(d =>
    d.scope && (d.scope.includes(projectName) || d.scope.includes("all"))
  );
  const projectIds = new Set(projectDecisions.map(d => d.id));
  return [...projectDecisions, ...relevantWs.filter(d => !projectIds.has(d.id))];
}

export function showDecisions(projectPath: string): string {
  const decisions = listDecisions(projectPath);
  if (decisions.length === 0) return "No decisions recorded.";
  return decisions.map(d => {
    const badge = d.enforce ? ` [${d.enforce}]` : "";
    return `- **${d.id}: ${d.title}**${badge} - ${d.decision}`;
  }).join("\n");
}

export function toSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

// --- Internal ---

function listDecisionFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.startsWith("D-") && f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

function formatDecisionFile(d: Decision): string {
  const scopeLine = d.scope?.length ? `\nscope: ${d.scope.join(", ")}` : "";
  const statusLine = d.status ? `\nstatus: ${d.status}` : "";
  const supersededByLine = d.supersededBy ? `\nsupersededBy: ${d.supersededBy}` : "";
  const supersedesLine = d.supersedes?.length ? `\nsupersedes: ${d.supersedes.join(", ")}` : "";
  const revokedAtLine = d.revokedAt ? `\nrevokedAt: ${d.revokedAt}` : "";
  const revokedReasonLine = d.revokedReason ? `\nrevokedReason: ${d.revokedReason}` : "";
  return `---
id: ${d.id}
slug: ${d.slug}
title: ${d.title}
date: ${d.date}
source: ${d.source}
enforce: ${d.enforce ?? ""}
sessionId: ${d.sessionId ?? ""}${scopeLine}${statusLine}${supersededByLine}${supersedesLine}${revokedAtLine}${revokedReasonLine}
---

# ${d.title}

${d.decision}

## Reasoning

${d.reasoning}
`;
}

function parseDecisionFile(filePath: string): Decision | null {
  try {
    const content = readFileSync(filePath, "utf-8");
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

    const enforceRaw = get("enforce");
    const scopeRaw = get("scope");

    const decisionMatch = body.match(/#\s+.*?\n\n([\s\S]*?)(?=\n## Reasoning)/m);
    const reasoningMatch = body.match(/## Reasoning\n\n([\s\S]*)/m);

    const statusRaw = get("status");
    const supersededByRaw = get("supersededBy");
    const supersedesRaw = get("supersedes");
    const revokedAtRaw = get("revokedAt");
    const revokedReasonRaw = get("revokedReason");

    return {
      id,
      slug: get("slug"),
      title,
      decision: decisionMatch?.[1]?.trim() ?? "",
      reasoning: reasoningMatch?.[1]?.trim() ?? "",
      date: get("date"),
      source: (get("source") || "manual") as Decision["source"],
      enforce: enforceRaw === "required" || enforceRaw === "advisory" ? enforceRaw : null,
      sessionId: get("sessionId") || null,
      ...(scopeRaw ? { scope: scopeRaw.split(",").map(s => s.trim()).filter(Boolean) } : {}),
      ...(statusRaw && ["active", "superseded", "deprecated", "revoked"].includes(statusRaw)
        ? { status: statusRaw as Decision["status"] } : {}),
      ...(supersededByRaw ? { supersededBy: supersededByRaw } : {}),
      ...(supersedesRaw ? { supersedes: supersedesRaw.split(",").map(s => s.trim()).filter(Boolean) } : {}),
      ...(revokedAtRaw ? { revokedAt: revokedAtRaw } : {}),
      ...(revokedReasonRaw ? { revokedReason: revokedReasonRaw } : {}),
    };
  } catch {
    return null;
  }
}

// In-process mutex for rebuildIndex: parallel addDecision calls in the same
// Node process serialize their index rebuilds to avoid last-writer-wins on
// index.md. Cross-process is already OK (O_EXCL on content files).
let _rebuildQueue = Promise.resolve();

function rebuildIndex(projectPath: string): void {
  _rebuildQueue = _rebuildQueue.then(() => _rebuildIndexSync(projectPath)).catch(() => {});
}

function _rebuildIndexSync(projectPath: string): void {
  const decisions = listDecisions(projectPath);
  const dir = decisionsDir(projectPath);
  const lines = ["# Decision Log", ""];
  if (decisions.length === 0) {
    lines.push("No decisions recorded yet.");
  } else {
    lines.push(`${decisions.length} decision(s) recorded.`, "");
    lines.push("| ID | Title | Enforce | Source | Date |");
    lines.push("|---|---|---|---|---|");
    for (const d of decisions) {
      lines.push(`| ${d.id} | ${d.title} | ${d.enforce ?? "-"} | ${d.source} | ${d.date} |`);
    }
  }
  atomicWrite(join(dir, "index.md"), lines.join("\n") + "\n");
}

function deduplicateDecisions(incoming: Decision[], existing: Decision[]): Decision[] {
  const existingKeys = new Set(existing.map(d => normalizeTitle(d.title)));
  const seen = new Set<string>();
  const result: Decision[] = [];
  for (const d of incoming) {
    const key = normalizeTitle(d.title);
    if (existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(d);
  }
  return result;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase()
    .replace(/\b(use|using|for|the|a|an|as|with|in|on|to|and|of|is|are)\b/g, "")
    .replace(/[^a-z0-9]/g, "").trim();
}
