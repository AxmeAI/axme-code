/**
 * Reads `.axme-code/backlog/*.md` for the sidebar list. We do the parse
 * locally rather than spawning `axme-code backlog list --json` per refresh
 * because the KbWatcher fires on every file change and subprocess latency
 * (200–500 ms) is felt as UI jank in the webview. The schema is stable
 * (B-NNN-slug.md + YAML frontmatter) so the duplication risk is bounded.
 *
 * Writes go through the canonical CLI subcommand (`axme-code backlog add`)
 * so ID generation + atomic write stay in one place — this module is
 * read-only.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type BacklogStatus = "open" | "in-progress" | "done" | "blocked";
export type BacklogPriority = "high" | "medium" | "low";

export interface BacklogItemLite {
  id: string;
  title: string;
  status: BacklogStatus;
  priority: BacklogPriority;
  path: string;
  updated: string;
}

export function readBacklog(workspaceRoot: string): BacklogItemLite[] {
  const dir = join(workspaceRoot, ".axme-code", "backlog");
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^B-\d+-.*\.md$/.test(f));
  } catch {
    return [];
  }
  const items: BacklogItemLite[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const content = readFileSync(path, "utf-8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(content);
      if (!fm) continue;
      const frontmatter = fm[1];
      const get = (k: string): string => {
        const m = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(frontmatter);
        return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
      };
      items.push({
        id: get("id") || (f.match(/^B-\d+/)?.[0] ?? f),
        title: get("title") || f,
        status: (get("status") || "open") as BacklogStatus,
        priority: (get("priority") || "medium") as BacklogPriority,
        path,
        updated: get("updated") || tryMtime(path),
      });
    } catch {
      /* skip unreadable */
    }
  }
  // Sort by status priority then by recency: in-progress → blocked →
  // open(high) → open(med) → open(low) → done. Within each tier, newer
  // updated_at first.
  const statusWeight: Record<BacklogStatus, number> = {
    "in-progress": 0, blocked: 1, open: 2, done: 3,
  };
  const priorityWeight: Record<BacklogPriority, number> = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => {
    const s = statusWeight[a.status] - statusWeight[b.status];
    if (s !== 0) return s;
    const p = priorityWeight[a.priority] - priorityWeight[b.priority];
    if (p !== 0) return p;
    return b.updated.localeCompare(a.updated);
  });
  return items;
}

function tryMtime(path: string): string {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return "";
  }
}
