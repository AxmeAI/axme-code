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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { IdeKind } from "./ide-detect.js";
import { log, logError } from "./log.js";
import { getBundledNode } from "./spawn-binary.js";

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

/**
 * Path to the Windows wrapper script. Lives next to hooks.json so a
 * single uninstall sweep deletes both. The wrapper is a one-liner .cmd
 * that sets ELECTRON_RUN_AS_NODE=1 and invokes Cursor.exe as a Node
 * interpreter on the bundled binary — see buildHookCommand() rationale
 * below for the full explanation.
 */
function windowsHookWrapperPath(): string {
  return join(homedir(), ".cursor", "axme-hook.cmd");
}

/**
 * Write the Windows .cmd wrapper that lets Cursor's hook runner invoke
 * our shebang-shim binary using the bundled Node.exe that ships inside
 * the .vsix. Returns the wrapper path (caller writes it into the hook
 * command string).
 *
 * Previously this wrapper invoked Cursor.exe with ELECTRON_RUN_AS_NODE=1
 * to use Cursor's own Electron as a Node interpreter. That approach
 * worked in theory but proved fragile in practice — Cursor's spawn
 * behaviour around that env var is inconsistent, and any Cursor update
 * could change it. Now the wrapper points at the Node.exe we ship
 * ourselves (extension/bin/node-windows-x64.exe), which is a plain
 * Node interpreter that just works.
 */
function writeWindowsHookWrapper(binary: string): string {
  const path = windowsHookWrapperPath();
  const bundledNode = getBundledNode();
  if (!bundledNode) {
    throw new Error(
      "AXME Code: cannot install Cursor hooks — bundled Node.exe not " +
        "found at extension/bin/node-windows-x64.exe. The .vsix may be " +
        "incomplete; please reinstall the extension.",
    );
  }
  // cmd.exe parser quirks:
  //   - `@echo off` silences the prompt echo
  //   - `setlocal` scopes any env changes to this script invocation
  //   - `%*` forwards all caller args verbatim (with quoting preserved)
  // The bundled Node and binary paths are absolute, captured at install
  // time. If the extension is uninstalled and reinstalled to a
  // different location, the user runs setup again and we rewrite this
  // file with the new paths.
  const content =
    `@echo off\r\n` +
    `setlocal\r\n` +
    `"${bundledNode}" "${binary}" %*\r\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  log(`Hooks: wrote Windows wrapper at ${path}`);
  return path;
}

function buildHookCommand(binary: string, hookName: string, wrapper?: string): string {
  // No --workspace flag — handler core resolves it from stdin
  // workspace_roots[0] (PR #129 commit d267b82).
  //
  // Cross-platform: the bundled binary is a shebang shim (`#!/usr/bin/env
  // node` + CJS payload). POSIX honors the shebang and runs it directly.
  // Windows ignores shebangs and fails with ENOENT when cmd.exe / Cursor
  // tries to exec the file. We do NOT rely on Node being on PATH (most
  // Windows chat-IDE users do not have it) — instead, a .cmd wrapper
  // invokes the bundled Node.exe (shipped inside the .vsix) directly.
  // The wrapper is written ONCE by installUserHooks() before this
  // function is called for each hook kind; we just reference the
  // shared wrapper path here. Callers pass it via the `wrapper` arg
  // on Windows; non-Windows callers can omit it.
  if (process.platform === "win32") {
    if (!wrapper) throw new Error("buildHookCommand: wrapper path is required on Windows");
    return `${quote(wrapper)} hook ${hookName} --ide cursor`;
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

  // Write the Windows .cmd wrapper ONCE before the per-hook loop —
  // the file is identical for all three hook kinds (it just forwards
  // %* to the bundled Node + binary). Earlier the wrapper was
  // written 3× inside the loop, producing 3 redundant "Hooks: wrote
  // Windows wrapper" log lines on activation.
  const wrapper = process.platform === "win32" ? writeWindowsHookWrapper(binary) : undefined;

  for (const kind of ["preToolUse", "postToolUse", "sessionEnd"] as HookKind[]) {
    const existing = cfg.hooks[kind] ?? [];
    const preserved = existing.filter(
      (e) => !String(e.command ?? "").includes("axme-code"),
    );
    const fresh: CursorHookEntry = {
      command: buildHookCommand(binary, cliNames[kind], wrapper),
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
  // Drop the Windows .cmd wrapper (no-op on POSIX — the file never existed).
  if (process.platform === "win32") {
    const wrapper = windowsHookWrapperPath();
    if (existsSync(wrapper)) {
      try {
        unlinkSync(wrapper);
        log(`Hooks: removed Windows wrapper ${wrapper}`);
      } catch (err) {
        logError("Hooks: wrapper removal failed", err);
      }
    }
  }
}
