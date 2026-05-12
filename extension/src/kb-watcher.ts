/**
 * Watches `.axme-code/` knowledge-base sources in the active workspace and
 * reports counts to a callback whenever they change. The sidebar webview
 * and the status bar both subscribe — counts update live as the agent
 * saves new memories, decisions, backlog items, etc. during the chat.
 *
 * Layout we track:
 *   .axme-code/memory/feedback/*.md   → memories
 *   .axme-code/memory/patterns/*.md   → memories
 *   .axme-code/decisions/*.md         → decisions (excluding index.md)
 *   .axme-code/backlog/*.md           → backlog items (excluding index.md)
 *   .axme-code/safety/rules.yaml      → safety (count of rule entries inside)
 *   .axme-code/open-questions.md      → questions (count of open Q-NNN entries)
 */

import * as vscode from "vscode";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface KbCounts {
  memories: number;
  decisions: number;
  safety: number;
  backlog: number;
  questions: number;
}

function emptyCounts(): KbCounts {
  return { memories: 0, decisions: 0, safety: 0, backlog: 0, questions: 0 };
}

function countFilesIn(dir: string, suffix = ".md"): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(suffix) && f !== "index.md").length;
  } catch {
    return 0;
  }
}

function countMemoriesUnder(memoryDir: string): number {
  if (!existsSync(memoryDir)) return 0;
  let total = 0;
  for (const sub of ["feedback", "patterns"]) {
    total += countFilesIn(join(memoryDir, sub));
  }
  return total;
}

function countSafetyRules(rulesPath: string): number {
  if (!existsSync(rulesPath)) return 0;
  try {
    const txt = readFileSync(rulesPath, "utf-8");
    // safety/rules.yaml is a nested-object schema (git.*, bash.*, filesystem.*)
    // with arrays under each. Every `^  - X` line (any indent depth + dash +
    // value) is one rule entry: a protected branch, a denied bash prefix, a
    // denied command, a denied filesystem path, an allowed bash prefix, etc.
    // Counting them all is a reasonable proxy for "how guarded is this
    // workspace" — matches what users intuit when they read "Safety rules: N".
    const matches = txt.match(/^\s+-\s+\S/gm);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function countOpenQuestions(qPath: string): number {
  if (!existsSync(qPath)) return 0;
  try {
    const txt = readFileSync(qPath, "utf-8");
    const matches = txt.match(/^##\s+Q-\d+\s+\[open\]/gm);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

export function readCounts(workspaceRoot: string): KbCounts {
  const axmeDir = join(workspaceRoot, ".axme-code");
  if (!existsSync(axmeDir)) return emptyCounts();
  return {
    memories: countMemoriesUnder(join(axmeDir, "memory")),
    decisions: countFilesIn(join(axmeDir, "decisions")),
    safety: countSafetyRules(join(axmeDir, "safety", "rules.yaml")),
    backlog: countFilesIn(join(axmeDir, "backlog")),
    questions: countOpenQuestions(join(axmeDir, "open-questions.md")),
  };
}

export class KbWatcher implements vscode.Disposable {
  private contentWatcher: vscode.FileSystemWatcher | undefined;
  private rootWatcher: vscode.FileSystemWatcher | undefined;
  private listener: ((counts: KbCounts) => void) | undefined;
  private creationListener: (() => void) | undefined;
  private workspaceRoot: string | undefined;

  /**
   * Attach to a workspace. The watcher handles both states:
   *
   *   1. `.axme-code/` already exists → watch its content files for
   *      add/change/delete (memories, decisions, backlog, safety, open-
   *      questions) and refresh counts on every event.
   *   2. `.axme-code/` does NOT exist yet (fresh repo, pre-setup) → watch
   *      the workspace root for the directory's creation. The moment it
   *      appears (cooperative setup just ran inside the chat) we switch
   *      to the content watcher and trigger the optional onCreated
   *      callback so callers (walkthrough context flag, sidebar
   *      "Initialised" pill) can react.
   *
   * The two states are not mutually exclusive over the lifetime of the
   * watcher — a workspace that starts uninitialised will transition to
   * initialised the moment the agent (or the CLI) writes the directory,
   * and the watcher must pick that up without requiring a re-attach
   * from the caller.
   */
  attach(
    workspaceRoot: string,
    onChange: (counts: KbCounts) => void,
    onCreated?: () => void,
  ): void {
    this.detach();
    this.workspaceRoot = workspaceRoot;
    this.listener = onChange;
    this.creationListener = onCreated;

    if (existsSync(join(workspaceRoot, ".axme-code"))) {
      this.startContentWatcher(workspaceRoot);
      onChange(readCounts(workspaceRoot));
    } else {
      onChange(emptyCounts());
      this.startRootWatcher(workspaceRoot);
    }
  }

  /**
   * Watch `<workspaceRoot>/.axme-code/` for content-file events. This is
   * the steady-state mode once setup has run.
   */
  private startContentWatcher(workspaceRoot: string): void {
    const pattern = new vscode.RelativePattern(
      workspaceRoot,
      ".axme-code/{memory/**/*.md,decisions/*.md,backlog/*.md,safety/rules.yaml,open-questions.md}",
    );
    this.contentWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = () => {
      try {
        if (!this.workspaceRoot || !this.listener) return;
        try { statSync(join(this.workspaceRoot, ".axme-code")); } catch { return; }
        this.listener(readCounts(this.workspaceRoot));
      } catch { /* swallow */ }
    };
    this.contentWatcher.onDidCreate(refresh);
    this.contentWatcher.onDidDelete(refresh);
    this.contentWatcher.onDidChange(refresh);
  }

  /**
   * Watch the workspace root for `.axme-code` creation. The FS watcher API
   * matches by glob pattern, so we ask for `.axme-code` literally — when
   * Code or the agent creates the directory the onDidCreate event fires
   * once. We then tear down the root watcher, install the content
   * watcher, push a fresh count, and call the optional onCreated callback
   * so higher-level surfaces (walkthrough completion, sidebar pill) can
   * flip from "setup required" to "ready".
   */
  private startRootWatcher(workspaceRoot: string): void {
    const pattern = new vscode.RelativePattern(workspaceRoot, ".axme-code");
    this.rootWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, true, true);
    this.rootWatcher.onDidCreate(() => {
      if (!this.workspaceRoot || !this.listener) return;
      // Switch into content-watcher mode and emit a fresh count.
      this.rootWatcher?.dispose();
      this.rootWatcher = undefined;
      this.startContentWatcher(this.workspaceRoot);
      try { this.listener(readCounts(this.workspaceRoot)); } catch { /* swallow */ }
      try { this.creationListener?.(); } catch { /* swallow */ }
    });
  }

  detach(): void {
    this.contentWatcher?.dispose();
    this.contentWatcher = undefined;
    this.rootWatcher?.dispose();
    this.rootWatcher = undefined;
    this.listener = undefined;
    this.creationListener = undefined;
    this.workspaceRoot = undefined;
  }

  dispose(): void {
    this.detach();
  }
}
