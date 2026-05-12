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

/** Compact signature for change detection. Only fires the listener
 *  callback when at least one count actually moved — keeps the sidebar
 *  from re-rendering on every 5-second poll tick when nothing changed. */
function signatureOf(c: KbCounts): string {
  return `${c.memories}|${c.decisions}|${c.safety}|${c.backlog}|${c.questions}`;
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
    // Count only ENFORCEMENT entries — the things that actually block
    // something. The allow-list (bash.allowedPrefixes) is the bulk of
    // rules.yaml (~50 items shipped in the preset) but those are
    // fast-path whitelisting, not "rules". Counting them made the
    // displayed number meaningless: a fresh setup shows 70+ "rules"
    // when the agent only just added 3, which is what the user sees as
    // a bug.
    //
    // Sections we count (each list item underneath = one rule):
    //   git.protectedBranches
    //   bash.deniedPrefixes
    //   bash.deniedCommands
    //   filesystem.deniedPaths
    //   filesystem.readOnlyPaths
    //
    // Sections we ignore:
    //   bash.allowedPrefixes (allow-list, not enforcement)
    //   any future allow-list keys
    //
    // We don't pull a YAML parser — the schema is stable and a simple
    // line-by-line walker keyed off the section header is enough.
    const lines = txt.split("\n");
    const ENFORCED = new Set([
      "protectedbranches",
      "deniedprefixes",
      "deniedcommands",
      "deniedpaths",
      "readonlypaths",
    ]);
    let current: string | null = null;
    let count = 0;
    for (const line of lines) {
      const sectionMatch = /^(\s*)([A-Za-z]+)\s*:\s*$/.exec(line);
      if (sectionMatch) {
        const key = sectionMatch[2].toLowerCase();
        current = ENFORCED.has(key) ? key : null;
        continue;
      }
      // Reset when we leave the section's indentation level back to a
      // higher-level scalar.
      if (current && /^\S/.test(line)) {
        current = null;
      }
      if (current && /^\s+-\s+\S/.test(line)) {
        count++;
      }
    }
    return count;
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

/**
 * KbWatcher polling fallback interval. VS Code's FileSystemWatcher uses
 * inotify (Linux) / FSEvents (Mac) which only fire on directories that
 * exist at watch-creation time. When `.axme-code/memory/patterns/` is
 * created mid-session (first save by the agent), the watcher silently
 * misses early events and the counts only refresh after VS Code's
 * polling fallback kicks in (30–60 s later). The 5-second poll catches
 * this case without relying on the event stream — counts visibly update
 * within at-most 5 seconds of any change, even on the very first save.
 *
 * Why 5 s and not faster: reading 5 directories' mtime is microseconds,
 * but running it 10× per second is overkill for "did something change".
 * 5 s is faster than any human notices "did my save register" and slow
 * enough to be invisible CPU-wise.
 */
const KB_POLL_MS = 5_000;

export class KbWatcher implements vscode.Disposable {
  private contentWatcher: vscode.FileSystemWatcher | undefined;
  private rootWatcher: vscode.FileSystemWatcher | undefined;
  private listener: ((counts: KbCounts) => void) | undefined;
  private creationListener: (() => void) | undefined;
  private workspaceRoot: string | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private lastSig: string | undefined;

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
      const c = readCounts(workspaceRoot);
      this.lastSig = signatureOf(c);
      onChange(c);
    } else {
      onChange(emptyCounts());
      this.lastSig = signatureOf(emptyCounts());
      this.startRootWatcher(workspaceRoot);
    }
    this.startPolling();
  }

  /**
   * Polling fallback. Runs forever (cleared on detach/dispose) at
   * KB_POLL_MS. Re-reads counts; if the signature changed, pushes the
   * new value. If `.axme-code/` only just appeared mid-poll, also
   * upgrades the rootWatcher to a contentWatcher and fires onCreated.
   *
   * The signature compare keeps the callback quiet when nothing
   * actually changed — KbWatcher subscribers (sidebar, status bar) can
   * trust that they only get called on real diffs.
   */
  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      if (!this.workspaceRoot || !this.listener) return;
      try {
        const axmeExists = existsSync(join(this.workspaceRoot, ".axme-code"));
        // Late-creation: rootWatcher should have caught it, but in case
        // VS Code's pattern-based dir watcher missed the event we
        // re-attach the content watcher here too.
        if (axmeExists && !this.contentWatcher) {
          this.rootWatcher?.dispose();
          this.rootWatcher = undefined;
          this.startContentWatcher(this.workspaceRoot);
          try { this.creationListener?.(); } catch { /* swallow */ }
        }
        const counts = readCounts(this.workspaceRoot);
        const sig = signatureOf(counts);
        if (sig !== this.lastSig) {
          this.lastSig = sig;
          this.listener(counts);
        }
      } catch { /* swallow */ }
    }, KB_POLL_MS);
  }

  /**
   * Watch `<workspaceRoot>/.axme-code/` for content-file events. Pattern
   * is intentionally broad: ".axme-code/**". An earlier draft used a
   * brace expansion enumerating the 5 KB sources individually
   * (memory/**, decisions/*.md, etc.), which forced VS Code to set up
   * an inotify watch on each subdir at watcher-creation time. If those
   * subdirs didn't exist yet (fresh workspace where the agent is about
   * to create them via cooperative setup), inotify couldn't subscribe
   * and VS Code fell back to its 30–60-second polling loop — counters
   * looked frozen for a full minute after the first save. The broad
   * pattern + dot-prefix early creation means VS Code wraps the watch
   * around the .axme-code/ dir itself, recursively catches nested
   * creations, and fires events within ~100 ms. The 5-second poll in
   * startPolling() is a belt-and-braces fallback for the case where
   * even the broad watcher misses something.
   */
  private startContentWatcher(workspaceRoot: string): void {
    const pattern = new vscode.RelativePattern(workspaceRoot, ".axme-code/**");
    this.contentWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = () => {
      try {
        if (!this.workspaceRoot || !this.listener) return;
        try { statSync(join(this.workspaceRoot, ".axme-code")); } catch { return; }
        const counts = readCounts(this.workspaceRoot);
        const sig = signatureOf(counts);
        if (sig !== this.lastSig) {
          this.lastSig = sig;
          this.listener(counts);
        }
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
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.lastSig = undefined;
    this.listener = undefined;
    this.creationListener = undefined;
    this.workspaceRoot = undefined;
  }

  dispose(): void {
    this.detach();
  }
}
