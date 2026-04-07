/**
 * Backlog - persistent cross-session task tracking.
 *
 * Files: .axme-code/backlog/B-NNN-<slug>.md
 *
 * Unlike TodoWrite (ephemeral per-session), backlog items persist
 * across sessions and are loaded into context at session start.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, ensureDir, pathExists, removeFile, readSafe } from "./engine.js";
import { AXME_CODE_DIR } from "../types.js";

const BACKLOG_DIR = "backlog";

export type BacklogStatus = "open" | "in-progress" | "done" | "blocked";
export type BacklogPriority = "high" | "medium" | "low";

export interface BacklogItem {
  id: string;
  slug: string;
  title: string;
  status: BacklogStatus;
  priority: BacklogPriority;
  description: string;
  tags: string[];
  created: string;
  updated: string;
  notes?: string;
}

// --- Public API ---

export function initBacklogStore(projectPath: string): void {
  ensureDir(backlogDir(projectPath));
}

export function addBacklogItem(
  projectPath: string,
  input: { title: string; description: string; priority?: BacklogPriority; tags?: string[] },
): BacklogItem {
  ensureDir(backlogDir(projectPath));
  const existing = listBacklogItems(projectPath);
  const nextNum = existing.length > 0
    ? Math.max(...existing.map(d => parseInt(d.id.replace("B-", ""), 10) || 0)) + 1
    : 1;
  const id = `B-${String(nextNum).padStart(3, "0")}`;
  const slug = toBacklogSlug(input.title);
  const today = new Date().toISOString().slice(0, 10);
  const item: BacklogItem = {
    id,
    slug,
    title: input.title,
    status: "open",
    priority: input.priority ?? "medium",
    description: input.description,
    tags: input.tags ?? [],
    created: today,
    updated: today,
  };
  atomicWrite(itemPath(projectPath, id, slug), formatBacklogFile(item));
  return item;
}

export function updateBacklogItem(
  projectPath: string,
  idOrSlug: string,
  updates: { status?: BacklogStatus; priority?: BacklogPriority; notes?: string },
): BacklogItem | null {
  const item = getBacklogItem(projectPath, idOrSlug);
  if (!item) return null;
  if (updates.status) item.status = updates.status;
  if (updates.priority) item.priority = updates.priority;
  if (updates.notes) {
    item.notes = item.notes
      ? item.notes + "\n\n" + updates.notes
      : updates.notes;
  }
  item.updated = new Date().toISOString().slice(0, 10);
  atomicWrite(itemPath(projectPath, item.id, item.slug), formatBacklogFile(item));
  return item;
}

export function listBacklogItems(projectPath: string, status?: BacklogStatus): BacklogItem[] {
  const dir = backlogDir(projectPath);
  if (!pathExists(dir)) return [];
  const files = readdirSync(dir).filter(f => f.startsWith("B-") && f.endsWith(".md")).sort();
  const items = files.map(f => parseBacklogFile(readFileSync(join(dir, f), "utf-8"))).filter(Boolean) as BacklogItem[];
  if (status) return items.filter(i => i.status === status);
  return items;
}

export function getBacklogItem(projectPath: string, idOrSlug: string): BacklogItem | null {
  const items = listBacklogItems(projectPath);
  const normalized = idOrSlug.toUpperCase();
  return items.find(i => i.id === normalized || i.id === idOrSlug || i.slug === idOrSlug) ?? null;
}

export function backlogExists(projectPath: string): boolean {
  return pathExists(backlogDir(projectPath));
}

export function backlogDir(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, BACKLOG_DIR);
}

/**
 * Context string for axme_context: show count + high-priority open items.
 */
export function backlogContext(projectPath: string): string {
  const items = listBacklogItems(projectPath);
  if (items.length === 0) return "";
  const open = items.filter(i => i.status === "open");
  const inProgress = items.filter(i => i.status === "in-progress");
  const blocked = items.filter(i => i.status === "blocked");
  const done = items.filter(i => i.status === "done");

  const lines = ["## Backlog", ""];
  lines.push(`${open.length} open, ${inProgress.length} in-progress, ${blocked.length} blocked, ${done.length} done`);

  // Show in-progress and high-priority open items inline
  const urgent = [...inProgress, ...blocked, ...open.filter(i => i.priority === "high")];
  if (urgent.length > 0) {
    lines.push("");
    for (const item of urgent.slice(0, 10)) {
      const tag = item.status === "in-progress" ? "WIP" : item.status === "blocked" ? "BLOCKED" : "HIGH";
      lines.push(`- [${tag}] ${item.id}: ${item.title}`);
    }
  }
  if (open.length > urgent.filter(i => i.status === "open").length) {
    lines.push(`- ... and ${open.length - urgent.filter(i => i.status === "open").length} more open items`);
  }

  return lines.join("\n");
}

/**
 * Full backlog display for axme_backlog tool.
 */
export function showBacklog(projectPath: string, status?: BacklogStatus): string {
  const items = listBacklogItems(projectPath, status);
  if (items.length === 0) return status ? `No ${status} backlog items.` : "No backlog items.";
  return items.map(i => {
    const tags = i.tags.length > 0 ? ` [${i.tags.join(", ")}]` : "";
    const notes = i.notes ? `\n  Notes: ${i.notes.split("\n")[0]}...` : "";
    return `- ${i.id}: ${i.title} (${i.status}, ${i.priority})${tags}${notes}`;
  }).join("\n");
}

// --- Internal ---

function itemPath(projectPath: string, id: string, slug: string): string {
  return join(backlogDir(projectPath), `${id}-${slug}.md`);
}

export function toBacklogSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

function formatBacklogFile(item: BacklogItem): string {
  const lines = [
    "---",
    `id: ${item.id}`,
    `slug: ${item.slug}`,
    `title: "${item.title.replace(/"/g, '\\"')}"`,
    `status: ${item.status}`,
    `priority: ${item.priority}`,
    `tags: [${item.tags.map(t => `"${t}"`).join(", ")}]`,
    `created: ${item.created}`,
    `updated: ${item.updated}`,
    "---",
    "",
    item.description,
  ];
  if (item.notes) {
    lines.push("", "## Notes", "", item.notes);
  }
  return lines.join("\n") + "\n";
}

function parseBacklogFile(content: string): BacklogItem | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const body = fmMatch[2].trim();

  const get = (key: string): string => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };

  const tagsMatch = fm.match(/^tags:\s*\[(.*)\]/m);
  const tags = tagsMatch
    ? tagsMatch[1].split(",").map(t => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
    : [];

  // Split body into description and notes
  const notesIdx = body.indexOf("## Notes");
  const description = notesIdx >= 0 ? body.slice(0, notesIdx).trim() : body;
  const notes = notesIdx >= 0 ? body.slice(notesIdx + "## Notes".length).trim() : undefined;

  return {
    id: get("id"),
    slug: get("slug"),
    title: get("title"),
    status: (get("status") || "open") as BacklogStatus,
    priority: (get("priority") || "medium") as BacklogPriority,
    description,
    tags,
    created: get("created"),
    updated: get("updated"),
    notes,
  };
}
