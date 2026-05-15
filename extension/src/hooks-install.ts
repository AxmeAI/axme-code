/**
 * Install AXME safety hooks at the user level by writing
 * `~/.cursor/hooks.json`. User-level hooks apply to every project the
 * user opens in Cursor — install once via the extension, get safety
 * enforcement everywhere.
 *
 * VS Code has no equivalent hooks API (verified via VS Code 1.119
 * release notes 2026-05-10 — no chat-tool interception primitive).
 * For VS Code users this function is a no-op; safety degrades to the
 * cooperative `axme_safety_check` MCP tool that the agent can call
 * before risky operations.
 *
 * Hook commands include `--ide cursor` so the spawned subprocess
 * (axme-code hook ...) picks the Cursor adapter and reads its stdin
 * with the right schema. The handler core falls back to stdin's
 * `workspace_roots[0]` for the workspace path (PR #129 third commit),
 * so we don't need to embed a project-specific path here.
 *
 * Idempotency: read existing hooks.json, drop any prior axme entries by
 * string-matching `axme-code` in the command, push fresh entries. User-
 * added entries are preserved verbatim.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { IdeKind } from "./ide-detect.js";
import { log, logError } from "./log.js";

type HookKind = "preToolUse" | "postToolUse" | "sessionEnd";

interface CursorHookEntry {
  command: string;
  type?: "command";
  timeout?: number;
  matcher?: string;
  failClosed?: boolean;
  loop_limit?: number | null;
  [key: string]: unknown;
}

interface CursorHooksFile {
  version?: number;
  hooks?: Partial<Record<HookKind, CursorHookEntry[]>>;
  [key: string]: unknown;
}

const HOOK_TIMEOUT_MS: Record<HookKind, number> = {
  preToolUse: 5,
  postToolUse: 10,
  sessionEnd: 120,
};

function quote(s: string): string {
  // Cursor hook commands run via shell. Quote with double-quotes; escape
  // any embedded double-quotes. Paths with spaces survive sh -c / cmd.exe /c
  // unchanged.
  return `"${s.replace(/"/g, '\\"')}"`;
}

function buildHookCommand(binary: string, hookName: string): string {
  // No --workspace flag — handler core resolves it from stdin
  // workspace_roots[0] (PR #129 commit d267b82).
  //
  // Cross-platform: the bundled binary is a shebang shim (`#!/usr/bin/env
  // node` + CJS payload). POSIX honors the shebang and runs it directly.
  // Windows ignores shebangs and fails with ENOENT when cmd.exe / Cursor
  // tries to exec the file. On Windows we prefix the command with `node`,
  // which Cursor users on Windows typically have on PATH (standard dev
  // setup). Falls through gracefully — Cursor's hook runner uses cmd.exe
  // /c so PATH lookup works the same as in any terminal.
  if (process.platform === "win32") {
    return `node ${quote(binary)} hook ${hookName} --ide cursor`;
  }
  return `${quote(binary)} hook ${hookName} --ide cursor`;
}

export function userCursorHooksPath(): string {
  return join(homedir(), ".cursor", "hooks.json");
}

/**
 * Write user-level Cursor hooks. No-op for VS Code (which has no hooks API).
 * Returns true when the file was written, false when skipped (VS Code or
 * setting disabled).
 */
export function installUserHooks(ide: IdeKind, binary: string): boolean {
  if (ide !== "cursor") {
    log("Hooks: skipped (not running in Cursor — VS Code has no hooks API)");
    return false;
  }

  const path = userCursorHooksPath();
  let cfg: CursorHooksFile = { version: 1, hooks: {} };
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") cfg = parsed as CursorHooksFile;
    } catch (err) {
      logError(`Hooks: existing ${path} is malformed; will overwrite`, err);
      cfg = { version: 1, hooks: {} };
    }
  }
  if (!cfg.version) cfg.version = 1;
  if (!cfg.hooks) cfg.hooks = {};

  const cliNames: Record<HookKind, string> = {
    preToolUse: "pre-tool-use",
    postToolUse: "post-tool-use",
    sessionEnd: "session-end",
  };

  for (const kind of ["preToolUse", "postToolUse", "sessionEnd"] as HookKind[]) {
    const existing = cfg.hooks[kind] ?? [];
    const preserved = existing.filter(
      (e) => !String(e.command ?? "").includes("axme-code"),
    );
    const fresh: CursorHookEntry = {
      command: buildHookCommand(binary, cliNames[kind]),
      type: "command",
      timeout: HOOK_TIMEOUT_MS[kind],
    };
    cfg.hooks[kind] = [...preserved, fresh];
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  log(`Hooks: installed at ${path} (preToolUse + postToolUse + sessionEnd)`);
  return true;
}

/**
 * Remove all axme entries from the user-level hooks file. Called on
 * extension uninstall / disable. User entries are preserved.
 */
export function uninstallUserHooks(): void {
  const path = userCursorHooksPath();
  if (!existsSync(path)) return;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as CursorHooksFile;
    if (!cfg.hooks) return;
    let touched = false;
    for (const kind of ["preToolUse", "postToolUse", "sessionEnd"] as HookKind[]) {
      const arr = cfg.hooks[kind];
      if (!arr) continue;
      const preserved = arr.filter((e) => !String(e.command ?? "").includes("axme-code"));
      if (preserved.length !== arr.length) {
        cfg.hooks[kind] = preserved;
        touched = true;
      }
    }
    if (touched) {
      writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
      log(`Hooks: removed axme entries from ${path}`);
    }
  } catch (err) {
    logError("Hooks: uninstall failed", err);
  }
}
