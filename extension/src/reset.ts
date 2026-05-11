/**
 * `AXME: Reset` command — removes machine-level AXME state so the user
 * can start over after a botched install or before reporting an issue.
 *
 * What this DOES touch:
 *   - `~/.cursor/hooks.json` axme entries (preserves user's non-axme entries)
 *   - `~/.config/axme-code/auth.yaml` (mode flag — `subscription` / `api_key`
 *     / `cursor_sdk`)
 *   - `~/.config/axme-code/cursor.yaml` (Cursor SDK API key — only when
 *     user explicitly opts in via the confirm dialog)
 *
 * What this does NOT touch:
 *   - per-project `.axme-code/` storage (memories, decisions — user's
 *     curated knowledge; removing them across all projects would be
 *     catastrophic)
 *   - extension itself (use Cursor's Extensions panel → Uninstall)
 *   - Cursor's own MCP server registration (Cursor unregisters on
 *     extension deactivate via the Disposable we return from
 *     mcp-register.ts)
 *
 * The confirm dialog has three options:
 *   - "Reset hooks + auth mode" — preserves cursor.yaml key (you can
 *     reuse the API key on next setup)
 *   - "Reset everything (incl. Cursor API key)" — also wipes
 *     cursor.yaml so the next install fully re-prompts
 *   - "Cancel"
 */

import * as vscode from "vscode";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log, logError } from "./log.js";

interface ResetReport {
  hooksTouched: boolean;
  authRemoved: boolean;
  cursorKeyRemoved: boolean;
  errors: string[];
}

function userCursorHooksPath(): string {
  return join(homedir(), ".cursor", "hooks.json");
}

function authYamlPath(): string {
  return join(homedir(), ".config", "axme-code", "auth.yaml");
}

function cursorYamlPath(): string {
  return join(homedir(), ".config", "axme-code", "cursor.yaml");
}

function removeAxmeHookEntries(): "removed" | "no-axme-entries" | "missing" | "parse-error" {
  const path = userCursorHooksPath();
  if (!existsSync(path)) return "missing";
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as {
      version?: number;
      hooks?: Partial<Record<"preToolUse" | "postToolUse" | "sessionEnd", Array<{ command?: string }>>>;
    };
    if (!cfg.hooks) return "no-axme-entries";
    let removedAny = false;
    for (const kind of ["preToolUse", "postToolUse", "sessionEnd"] as const) {
      const arr = cfg.hooks[kind];
      if (!arr) continue;
      const before = arr.length;
      const after = arr.filter((e) => !String(e.command ?? "").includes("axme-code"));
      if (after.length !== before) {
        cfg.hooks[kind] = after;
        removedAny = true;
      }
    }
    if (!removedAny) return "no-axme-entries";
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    return "removed";
  } catch (err) {
    logError("reset: hooks parse", err);
    return "parse-error";
  }
}

async function performReset(removeCursorKey: boolean): Promise<ResetReport> {
  const report: ResetReport = { hooksTouched: false, authRemoved: false, cursorKeyRemoved: false, errors: [] };

  // 1. hooks.json axme entries
  const hooksResult = removeAxmeHookEntries();
  if (hooksResult === "removed") {
    report.hooksTouched = true;
    log(`Reset: removed axme entries from ${userCursorHooksPath()}`);
  } else if (hooksResult === "parse-error") {
    report.errors.push(`hooks.json parse error — check ${userCursorHooksPath()}`);
  } else {
    log(`Reset: hooks ${hooksResult}, nothing to remove`);
  }

  // 2. auth.yaml — always remove on reset (user is explicitly resetting)
  const authPath = authYamlPath();
  if (existsSync(authPath)) {
    try {
      rmSync(authPath);
      report.authRemoved = true;
      log(`Reset: deleted ${authPath}`);
    } catch (err) {
      logError("reset: auth.yaml unlink", err);
      report.errors.push(`failed to delete ${authPath}: ${(err as Error).message}`);
    }
  }

  // 3. cursor.yaml — only when user explicitly opted in
  if (removeCursorKey) {
    const ckPath = cursorYamlPath();
    if (existsSync(ckPath)) {
      try {
        rmSync(ckPath);
        report.cursorKeyRemoved = true;
        log(`Reset: deleted ${ckPath}`);
      } catch (err) {
        logError("reset: cursor.yaml unlink", err);
        report.errors.push(`failed to delete ${ckPath}: ${(err as Error).message}`);
      }
    }
  }

  return report;
}

export async function runReset(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "AXME Code Reset — what should we clear?\n\n" +
      "• Hooks: ~/.cursor/hooks.json axme entries (your other hooks are preserved)\n" +
      "• Auth mode flag: ~/.config/axme-code/auth.yaml\n" +
      "• (optional) Cursor SDK key: ~/.config/axme-code/cursor.yaml\n\n" +
      "Per-project .axme-code/ storage (memories, decisions) is NOT touched.",
    { modal: true },
    "Reset hooks + auth mode",
    "Reset everything (incl. Cursor API key)",
  );

  if (choice === undefined) {
    log("Reset: cancelled by user");
    return;
  }

  const includeCursorKey = choice === "Reset everything (incl. Cursor API key)";
  const report = await performReset(includeCursorKey);

  // Build a single user-facing summary line.
  const parts: string[] = [];
  if (report.hooksTouched) parts.push("hooks ✓");
  if (report.authRemoved) parts.push("auth mode ✓");
  if (report.cursorKeyRemoved) parts.push("Cursor API key ✓");
  if (parts.length === 0) parts.push("nothing to remove (state was already clean)");

  if (report.errors.length === 0) {
    void vscode.window.showInformationMessage(
      `AXME Code reset complete: ${parts.join(", ")}. Reopen Cursor or run "AXME: Setup" on your next project to reinstall.`,
    );
  } else {
    void vscode.window.showWarningMessage(
      `AXME Code reset partial: ${parts.join(", ")} (${report.errors.length} error${report.errors.length === 1 ? "" : "s"}). See output channel.`,
      "Show output",
    );
  }
}
