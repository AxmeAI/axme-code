/**
 * Mirrors the `axme.auditorMode` VS Code setting to a tiny on-disk file
 * at `~/.config/axme-code/auditor-mode` so the core CLI/hooks (which know
 * nothing about VS Code settings) can gate their behaviour on the user's
 * choice.
 *
 * Source of truth: the VS Code setting. Disk is a one-way read-only
 * projection. We rewrite the file on:
 *   - activation (snapshot current setting)
 *   - onDidChangeConfiguration for "axme.auditorMode" (user-driven change
 *     via the sidebar dropdown OR the Settings UI)
 *
 * Keeping the file format trivial (one line, no YAML/JSON) means core
 * doesn't pull a parser into the hook path and the file is human-fixable
 * with any editor.
 */

import * as vscode from "vscode";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log, logError } from "./log.js";

export type AuditorMode = "cooperative" | "background";

function auditorModePath(): string {
  return join(homedir(), ".config", "axme-code", "auditor-mode");
}

export function currentAuditorMode(): AuditorMode {
  return vscode.workspace
    .getConfiguration("axme")
    .get<AuditorMode>("auditorMode", "cooperative");
}

export function writeAuditorModeFile(mode: AuditorMode): void {
  try {
    const p = auditorModePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, mode + "\n", "utf-8");
    try { chmodSync(p, 0o644); } catch { /* non-fatal */ }
    log(`Auditor mode mirrored to disk: ${mode}`);
  } catch (err) {
    logError("writeAuditorModeFile", err);
  }
}

/**
 * Register the activation snapshot + onDidChange listener. Returns a
 * disposable so callers can keep the subscription tied to context.
 */
export function installAuditorModeMirror(): vscode.Disposable {
  writeAuditorModeFile(currentAuditorMode());
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("axme.auditorMode")) {
      writeAuditorModeFile(currentAuditorMode());
    }
  });
}
