/**
 * Decision Log - architectural decisions with enforce levels.
 *
 * Files:
 *   .axme-code/decisions/index.md          summary
 *   .axme-code/decisions/D-001-<slug>.md   individual records
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite, ensureDir, pathExists } from "./engine.js";
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

export function addDecision(projectPath: string, input: Omit<Decision, "id">): Decision {
  const existing = listDecisions(projectPath);
  const nextNum = existing.length > 0
    ? Math.max(...existing.map(d => parseInt(d.id.replace("D-", ""), 10))) + 1
    : 1;
  const id = `D-${String(nextNum).padStart(3, "0")}`;
  const decision: Decision = { id, ...input };

  ensureDir(decisionsDir(projectPath));
  atomicWrite(join(decisionsDir(projectPath), `${id}-${decision.slug}.md`), formatDecisionFile(decision));
  rebuildIndex(projectPath);
  return decision;
}

export function listDecisions(projectPath: string): Decision[] {
  const dir = decisionsDir(projectPath);
  if (!pathExists(dir)) return [];

  const files = listDecisionFiles(dir);
  return files.map(f => parseDecisionFile(join(dir, f))).filter((d): d is Decision => d !== null);
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
  const lines = decisions.map(d => `- **${d.id}: ${d.title}** [${d.enforce ?? "info"}] - ${d.decision}`);
  return `## Project Decisions\n${lines.join("\n")}`;
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

export function saveScopedDecisions(
  decisions: Decision[], projectPath: string, workspacePath?: string,
): { saved: number; crossProject: number } {
  let saved = 0, crossProject = 0;
  const projectName = projectPath.split("/").pop() ?? "";

  for (const d of decisions) {
    if (!d.scope || d.scope.length === 0 || (d.scope.length === 1 && d.scope[0] === projectName)) {
      saveDecisions(projectPath, [d]);
      saved++;
    } else if (workspacePath) {
      saveDecisions(workspacePath, [d]);
      crossProject++;
      for (const target of d.scope) {
        if (target === "all") continue;
        const targetPath = resolve(workspacePath, target);
        if (pathExists(join(targetPath, ".axme-code")) || pathExists(join(targetPath, ".git"))) {
          saveDecisions(targetPath, [d]);
        }
      }
      saved++;
    } else {
      saveDecisions(projectPath, [d]);
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
    const lines = [`## ${d.id}: ${d.title}${badge}`, "", d.decision];
    if (d.reasoning) lines.push("", `**Reasoning:** ${d.reasoning}`);
    lines.push("", `*Source: ${d.source}, ${d.date}*`);
    return lines.join("\n");
  }).join("\n\n---\n\n");
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
  return `---
id: ${d.id}
slug: ${d.slug}
title: ${d.title}
date: ${d.date}
source: ${d.source}
enforce: ${d.enforce ?? ""}
sessionId: ${d.sessionId ?? ""}${scopeLine}
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
    };
  } catch {
    return null;
  }
}

function rebuildIndex(projectPath: string): void {
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
