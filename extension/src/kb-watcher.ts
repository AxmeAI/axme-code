/**
 * Watches `.axme-code/{memory,decisions}` in the active workspace and
 * reports counts to a callback whenever they change. The status bar
 * subscribes to this — counts update live as the agent saves new
 * memories / decisions during the chat.
 */

import * as vscode from "vscode";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface KbCounts {
  memories: number;
  decisions: number;
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
  // Two subdirs: feedback/ and patterns/. Count *.md in each.
  let total = 0;
  for (const sub of ["feedback", "patterns"]) {
    total += countFilesIn(join(memoryDir, sub));
  }
  return total;
}

export function readCounts(workspaceRoot: string): KbCounts {
  const axmeDir = join(workspaceRoot, ".axme-code");
  return {
    memories: countMemoriesUnder(join(axmeDir, "memory")),
    decisions: countFilesIn(join(axmeDir, "decisions")),
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
      onChange({ memories: 0, decisions: 0 });
      return;
    }
    const pattern = new vscode.RelativePattern(workspaceRoot, ".axme-code/{memory,decisions}/**/*.md");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = () => {
      try {
        if (!this.workspaceRoot || !this.listener) return;
        // statSync to throw early if dir was deleted
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
