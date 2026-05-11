/**
 * AXME status-bar item.
 *
 * Format: `AXME ✓ <N> mems, <D> dec` (live counts). On click — quick-pick
 * of recent decisions (read live from `.axme-code/decisions/index.md`).
 * Hidden if no workspace is open or `.axme-code/` is absent.
 */

import * as vscode from "vscode";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { KbCounts, KbWatcher } from "./kb-watcher.js";

const PRIORITY = 100;

export class AxmeStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private watcher: KbWatcher;
  private workspaceRoot: string | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, PRIORITY);
    this.item.command = "axme.showRecentDecisions";
    this.item.tooltip = "AXME Code — click to view recent decisions";
    this.watcher = new KbWatcher();
  }

  attach(workspaceRoot: string): void {
    this.workspaceRoot = workspaceRoot;
    this.watcher.attach(workspaceRoot, (counts) => this.render(counts));
    this.item.show();
  }

  private render(counts: KbCounts): void {
    this.item.text = `AXME $(check) ${counts.memories} mems, ${counts.decisions} dec`;
  }

  /**
   * Read up to 10 most-recent decisions for the quick-pick. Decisions are
   * named `D-NNN-<slug>.md` and sorted by file mtime descending.
   */
  recentDecisions(): Array<{ id: string; title: string; path: string }> {
    if (!this.workspaceRoot) return [];
    const dir = join(this.workspaceRoot, ".axme-code", "decisions");
    if (!existsSync(dir)) return [];
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => /^D-\d+-.*\.md$/.test(f));
    } catch {
      return [];
    }
    const withTimes = files.map((f) => {
      const path = join(dir, f);
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs; } catch { /* skip */ }
      return { f, path, mtime };
    });
    withTimes.sort((a, b) => b.mtime - a.mtime);
    return withTimes.slice(0, 10).map(({ f, path }) => {
      const id = (f.match(/^D-\d+/)?.[0]) ?? f;
      const title = parseTitleFromMd(path) ?? f;
      return { id, title, path };
    });
  }

  dispose(): void {
    this.watcher.dispose();
    this.item.dispose();
  }
}

function parseTitleFromMd(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf-8");
    // Try YAML frontmatter `title: "..."` first.
    const fm = /^---\n([\s\S]*?)\n---/.exec(content);
    if (fm) {
      const t = /^title:\s*(.+)$/m.exec(fm[1]);
      if (t) return t[1].trim().replace(/^["']|["']$/g, "");
    }
    // Else first H1.
    const h1 = /^#\s+(.+)$/m.exec(content);
    if (h1) return h1[1].trim();
  } catch { /* skip */ }
  return undefined;
}
