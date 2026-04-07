/**
 * Memory / Learning System - persistent project-specific memories.
 *
 * Files:
 *   .axme-code/memory/feedback/<slug>.md
 *   .axme-code/memory/patterns/<slug>.md
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite, ensureDir, pathExists, removeFile } from "./engine.js";
import type { Memory, MemoryType } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

const MEMORY_DIR = "memory";
const FEEDBACK_DIR = "feedback";
const PATTERNS_DIR = "patterns";

// --- Public API ---

export function initMemoryStore(projectPath: string): void {
  ensureDir(join(memoryDir(projectPath), FEEDBACK_DIR));
  ensureDir(join(memoryDir(projectPath), PATTERNS_DIR));
}

export function saveMemory(projectPath: string, memory: Memory): void {
  const subdir = memory.type === "feedback" ? FEEDBACK_DIR : PATTERNS_DIR;
  const dir = join(memoryDir(projectPath), subdir);
  ensureDir(dir);
  atomicWrite(join(dir, `${memory.slug}.md`), formatMemoryFile(memory));
}

export function saveMemories(projectPath: string, memories: Memory[]): void {
  for (const m of memories) saveMemory(projectPath, m);
}

/**
 * Save memories with scope-based routing.
 *
 * Routing:
 * - No scope / empty / ["all"] → session origin (projectPath). In a workspace
 *   session this is the workspace root (universal rule discoverable by every
 *   repo via merged context).
 * - [repoName] / [repoName, ...] → each listed repo's .axme-code/memory/ only.
 *   Does NOT also write to workspace root — the memory is repo-specific.
 */
export function saveScopedMemories(
  memories: Memory[], projectPath: string, workspacePath?: string,
): { saved: number; crossProject: number } {
  let saved = 0, crossProject = 0;
  const projectName = projectPath.split("/").pop() ?? "";

  for (const m of memories) {
    const scope = m.scope;
    const isAllScope = !scope || scope.length === 0 || (scope.length === 1 && scope[0] === "all");
    const isSelfScope = scope && scope.length === 1 && scope[0] === projectName;

    if (isAllScope) {
      saveMemory(projectPath, m);
      saved++;
    } else if (isSelfScope) {
      saveMemory(projectPath, m);
      saved++;
    } else if (workspacePath) {
      let writtenToRepo = false;
      for (const target of scope!) {
        if (target === "all") continue;
        const targetPath = resolve(workspacePath, target);
        if (pathExists(join(targetPath, ".axme-code")) || pathExists(join(targetPath, ".git"))) {
          initMemoryStore(targetPath);
          saveMemory(targetPath, m);
          writtenToRepo = true;
          crossProject++;
        }
      }
      // Fallback: if none of the listed repos exist, write to workspace root
      // so the memory isn't silently dropped. Warn so operators can spot typos.
      if (!writtenToRepo) {
        process.stderr.write(
          `AXME: warning: scope repos ${JSON.stringify(scope)} not found in workspace, saving to workspace root\n`,
        );
        saveMemory(workspacePath, m);
      }
      saved++;
    } else {
      saveMemory(projectPath, m);
      saved++;
    }
  }
  return { saved, crossProject };
}

export function listMemories(projectPath: string, type?: MemoryType): Memory[] {
  const result: Memory[] = [];
  const dirs: { subdir: string; type: MemoryType }[] = [
    { subdir: FEEDBACK_DIR, type: "feedback" },
    { subdir: PATTERNS_DIR, type: "pattern" },
  ];

  for (const { subdir, type: dirType } of dirs) {
    if (type && type !== dirType) continue;
    const dir = join(memoryDir(projectPath), subdir);
    if (!pathExists(dir)) continue;
    try {
      for (const f of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
        const m = parseMemoryFile(join(dir, f));
        if (m) result.push(m);
      }
    } catch {}
  }
  return result;
}

export function listScopedMemories(projectPath: string, workspacePath?: string): Memory[] {
  const projectMemories = listMemories(projectPath);
  if (!workspacePath || workspacePath === projectPath) return projectMemories;

  const projectName = projectPath.split("/").pop() ?? "";
  const wsMemories = listMemories(workspacePath);
  const relevantWs = wsMemories.filter(m =>
    m.scope && (m.scope.includes(projectName) || m.scope.includes("all"))
  );
  const projectSlugs = new Set(projectMemories.map(m => m.slug));
  return [...projectMemories, ...relevantWs.filter(m => !projectSlugs.has(m.slug))];
}

export function searchMemories(projectPath: string, keywords: string[]): Memory[] {
  if (keywords.length === 0) return [];
  const all = listMemories(projectPath);
  const normalized = keywords.map(k => k.toLowerCase());

  const scored: { memory: Memory; score: number }[] = [];
  for (const m of all) {
    let score = 0;
    const searchable = [m.title, m.description, m.body, ...m.keywords].join(" ").toLowerCase();
    for (const kw of normalized) {
      if (searchable.includes(kw)) score++;
    }
    if (score > 0) scored.push({ memory: m, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.memory);
}

export function getMemory(projectPath: string, slug: string): Memory | null {
  return listMemories(projectPath).find(m => m.slug === slug) ?? null;
}

export function deleteMemory(projectPath: string, slug: string): boolean {
  for (const subdir of [FEEDBACK_DIR, PATTERNS_DIR]) {
    if (removeFile(join(memoryDir(projectPath), subdir, `${slug}.md`))) return true;
  }
  return false;
}

export function memoryExists(projectPath: string): boolean {
  return pathExists(memoryDir(projectPath));
}

export function memoryDir(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, MEMORY_DIR);
}

export function memoryContext(projectPath: string, keywords: string[]): string {
  const relevant = searchMemories(projectPath, keywords).slice(0, 10);
  if (relevant.length === 0) return "";

  const feedbacks = relevant.filter(m => m.type === "feedback");
  const patterns = relevant.filter(m => m.type === "pattern");
  const parts: string[] = ["## Relevant Memories"];

  if (feedbacks.length > 0) {
    parts.push("\n### Feedback (learned from past mistakes):");
    for (const m of feedbacks) parts.push(`- **${m.title}**: ${m.description}`);
  }
  if (patterns.length > 0) {
    parts.push("\n### Patterns (successful approaches):");
    for (const m of patterns) parts.push(`- **${m.title}**: ${m.description}`);
  }
  return parts.join("\n");
}

export function allMemoryContext(projectPath: string): string {
  return getMemorySections(projectPath).join("\n");
}

/** Return memories as array of sections (for pagination). */
export function getMemorySections(projectPath: string): string[] {
  const all = listMemories(projectPath);
  if (all.length === 0) return [];

  const feedbacks = all.filter(m => m.type === "feedback");
  const patterns = all.filter(m => m.type === "pattern");
  const sections: string[] = [];

  if (feedbacks.length > 0) {
    sections.push(`### Feedback (${feedbacks.length}):\n` +
      feedbacks.map(m => `- **${m.title}**: ${m.description}`).join("\n"));
  }
  if (patterns.length > 0) {
    sections.push(`### Patterns (${patterns.length}):\n` +
      patterns.map(m => `- **${m.title}**: ${m.description}`).join("\n"));
  }
  return sections;
}

export function showMemories(projectPath: string, type?: MemoryType): string {
  const memories = listMemories(projectPath, type);
  if (memories.length === 0) return "No memories recorded yet.";
  return memories.map(m => {
    const lines = [`## ${m.title} [${m.type}]`, "", m.description];
    if (m.body) lines.push("", m.body);
    lines.push("", `*Source: ${m.source}, ${m.date} | Keywords: ${m.keywords.join(", ")}*`);
    return lines.join("\n");
  }).join("\n\n---\n\n");
}

export function toMemorySlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// --- File format ---

function formatMemoryFile(m: Memory): string {
  return `---
slug: ${m.slug}
type: ${m.type}
title: ${m.title}
source: ${m.source}
date: ${m.date}
keywords: ${m.keywords.join(", ")}
sessionId: ${m.sessionId ?? ""}${m.scope ? `\nscope: ${m.scope.join(", ")}` : ""}
---

# ${m.title}

${m.description}

## Details

${m.body}
`;
}

function parseMemoryFile(filePath: string): Memory | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];
    const body = fmMatch[2];
    const get = (key: string): string => {
      const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
      return m ? m[1].trim() : "";
    };

    const slug = get("slug");
    const type = get("type") as MemoryType;
    const title = get("title");
    if (!slug || !title || (type !== "feedback" && type !== "pattern")) return null;

    const keywordsRaw = get("keywords");
    const scopeRaw = get("scope");

    // Try to split body into description + details. If no ## Details section, entire body after title is the description.
    const descMatch = body.match(/#\s+.*?\n\n([\s\S]*?)(?=\n## Details)/m)
      ?? body.match(/#\s+.*?\n\n([\s\S]*)/m);
    const detailsMatch = body.match(/## Details\n\n([\s\S]*)/m);

    return {
      slug, type, title,
      description: descMatch?.[1]?.trim() ?? "",
      keywords: keywordsRaw ? keywordsRaw.split(",").map(k => k.trim()).filter(Boolean) : [],
      source: (get("source") || "manual") as Memory["source"],
      sessionId: get("sessionId") || null,
      date: get("date"),
      body: detailsMatch?.[1]?.trim() ?? "",
      ...(scopeRaw ? { scope: scopeRaw.split(",").map(s => s.trim()).filter(Boolean) } : {}),
    };
  } catch {
    return null;
  }
}
