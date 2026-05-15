/**
 * AXME status-bar item.
 *
 * Three visual states (helps surface activation problems instead of
 * leaving the user squinting at a faint notification toast):
 *
 *   - ✓ healthy:        "AXME ✓ N mems, D dec"  (default color)
 *   - ⚠ attention:      "AXME ⚠ Setup required"  (warning background)
 *   - ✗ error:          "AXME ✗ Activation failed"  (error background)
 *
 * Click action depends on state:
 *   - healthy  → quick-pick recent decisions
 *   - attention/error → open Show Status webview (so user can see what's wrong)
 */

import * as vscode from "vscode";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { KbCounts, KbWatcher } from "./kb-watcher.js";
import { isAxmeInitialized } from "./setup-controller.js";

const PRIORITY = 100;

export type StatusBarState = "healthy" | "attention" | "error";

export class AxmeStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private watcher: KbWatcher;
  private workspaceRoot: string | undefined;
  private state: StatusBarState = "healthy";

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

  /**
   * Called on every KbWatcher tick (~5s) plus on FS events. Responsible
   * for two things: redraw the counter text in healthy state, AND
   * auto-transition between healthy / attention based on whether the
   * workspace passes isAxmeInitialized() now. Previously this method
   * short-circuited when state !== "healthy" and the bar stayed
   * "Setup required" forever, even after the agent finished setup and
   * the sidebar's pill correctly flipped to "ready" — the two surfaces
   * disagreed. Both now read the same canonical signal.
   */
  private render(counts: KbCounts): void {
    if (this.state === "error") return;  // errors override attention/healthy
    if (!this.workspaceRoot) return;
    const initialized = isAxmeInitialized(this.workspaceRoot);
    if (!initialized) {
      if (this.state !== "attention") this.setAttention("Setup required");
      return;
    }
    if (this.state !== "healthy") {
      // Workspace just became initialised (e.g. agent finished setup
      // mid-session). Move ourselves out of attention without forcing
      // any caller to know we should.
      this.setHealthy();
      return;
    }
    this.item.text = `AXME $(check) ${counts.memories} mems, ${counts.decisions} dec`;
    this.item.backgroundColor = undefined;
  }

  /**
   * Switch to a non-healthy visual state. Used by activation to surface
   * "Setup required" or "Activation failed" prominently — far more visible
   * than a corner notification toast that auto-dismisses after 5 seconds.
   *
   * The status bar item also retargets its click command to `axme.showStatus`
   * so the user can drill into the webview and see what's wrong.
   */
  setAttention(message: string): void {
    this.state = "attention";
    this.item.text = `$(warning) AXME ⚠ ${message}`;
    this.item.tooltip = `AXME Code: ${message}. Click to open Show Status panel.`;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.item.command = "axme.showStatus";
    this.item.show();
  }

  setError(message: string): void {
    this.state = "error";
    this.item.text = `$(error) AXME ✗ ${message}`;
    this.item.tooltip = `AXME Code: ${message}. Click to open Show Status panel.`;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    this.item.command = "axme.showStatus";
    this.item.show();
  }

  setHealthy(): void {
    this.state = "healthy";
    this.item.tooltip = "AXME Code — click to view recent decisions";
    this.item.backgroundColor = undefined;
    this.item.command = "axme.showRecentDecisions";
    // The watcher will repaint the text on next event; force one now in
    // case attach() already fired and we missed it.
    if (this.workspaceRoot) {
      const { readCounts } = require("./kb-watcher.js") as typeof import("./kb-watcher.js");
      this.render(readCounts(this.workspaceRoot));
    }
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
