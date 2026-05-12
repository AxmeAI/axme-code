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
    // Match top-level YAML list entries `- id:` — robust to optional
    // surrounding whitespace and avoids counting nested keys. The safety
    // schema is a flat list, so this is sufficient without pulling a YAML
    // parser into the extension bundle.
    const matches = txt.match(/^\s*-\s+id\s*:/gm);
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
  private watcher: vscode.FileSystemWatcher | undefined;
  private listener: ((counts: KbCounts) => void) | undefined;
  private workspaceRoot: string | undefined;

  attach(workspaceRoot: string, onChange: (counts: KbCounts) => void): void {
    this.detach();
    this.workspaceRoot = workspaceRoot;
    this.listener = onChange;
    if (!existsSync(join(workspaceRoot, ".axme-code"))) {
      onChange(emptyCounts());
      return;
    }
    // Single pattern covering all 5 sources. We use {a,b,c} brace
    // expansion since createFileSystemWatcher accepts globstar.
    const pattern = new vscode.RelativePattern(
      workspaceRoot,
      ".axme-code/{memory/**/*.md,decisions/*.md,backlog/*.md,safety/rules.yaml,open-questions.md}",
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = () => {
      try {
        if (!this.workspaceRoot || !this.listener) return;
        try { statSync(join(this.workspaceRoot, ".axme-code")); } catch { return; }
        this.listener(readCounts(this.workspaceRoot));
      } catch { /* swallow */ }
    };
    this.watcher.onDidCreate(refresh);
    this.watcher.onDidDelete(refresh);
    this.watcher.onDidChange(refresh);
    onChange(readCounts(workspaceRoot));
  }

  detach(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.listener = undefined;
    this.workspaceRoot = undefined;
  }

  dispose(): void {
    this.detach();
  }
}
