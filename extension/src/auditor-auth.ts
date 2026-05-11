/**
 * First-run auditor credential prompt.
 *
 * The session auditor is a separate process spawned at chat end. It needs
 * its own LLM credential because vscode.lm.selectChatModels() is NOT
 * implemented in Cursor for third-party extensions (verified Jan 2025).
 *
 * Three modes:
 *   1. Anthropic API key — auditor uses Claude Agent SDK with this key.
 *   2. Cursor SDK API key — auditor uses @cursor/sdk with the user's
 *      Cursor account billing.
 *   3. Skip — auditor is disabled; user gets MCP tools + hooks but no
 *      automatic memory/decision extraction at chat end.
 *
 * The credential is persisted via the existing core auth-config helpers
 * (~/.config/axme-code/auth.yaml + ~/.config/axme-code/cursor.yaml).
 * That same storage is read by the audit worker spawned later, so the
 * extension and CLI share one auth state.
 */

import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { log, logError } from "./log.js";

export type AuditorAuthMode = "api_key" | "cursor_sdk" | "subscription" | "disabled";

const SETTING_KEY = "axme.auditor.authMode";

/**
 * Run the first-run auth flow if no credential is configured yet.
 * - If `axme-code auth status` reports a saved mode, this is a no-op.
 * - If unset, show a modal prompt with three buttons: paste Anthropic
 *   key / paste Cursor SDK key / skip auditor.
 * - On choice (other than skip), shell out to `axme-code auth use ...`
 *   to persist via the core flow (which knows where to put each key).
 */
export async function ensureAuditorAuth(binary: string): Promise<AuditorAuthMode> {
  // Check current state via `axme-code auth status` JSON output (ad-hoc
  // string parse — `auth status` prints human-readable text, but contains
  // "Current mode: <mode>" on one line if saved).
  const current = await detectCurrentMode(binary);
  if (current && current !== "disabled") {
    log(`Auditor auth: already configured (mode=${current})`);
    return current;
  }

  const choice = await vscode.window.showInformationMessage(
    "AXME Code needs an LLM credential to run the session auditor at the end of each chat. Pick one:",
    { modal: true },
    "Anthropic API key",
    "Cursor SDK key",
    "Skip auditor",
  );

  if (choice === "Skip auditor" || choice === undefined) {
    await vscode.workspace
      .getConfiguration()
      .update(SETTING_KEY, "disabled", vscode.ConfigurationTarget.Global);
    log("Auditor auth: skipped by user");
    return "disabled";
  }

  if (choice === "Anthropic API key") {
    const key = await promptKey("Anthropic API key", "sk-ant-...");
    if (!key) return "disabled";
    const ok = await runShell(binary, ["auth", "use", "api_key"], { ANTHROPIC_API_KEY: key });
    if (ok) {
      log("Auditor auth: saved as api_key (Anthropic)");
      return "api_key";
    }
    void vscode.window.showErrorMessage("AXME Code: failed to save Anthropic API key. Check the AXME Code output channel.");
    return "disabled";
  }

  if (choice === "Cursor SDK key") {
    const key = await promptKey("Cursor SDK API key", "sk-cursor-... (from cursor.com → Integrations)");
    if (!key) return "disabled";
    const ok = await runShell(binary, ["auth", "use", "cursor_sdk"], { CURSOR_API_KEY: key });
    if (ok) {
      log("Auditor auth: saved as cursor_sdk");
      return "cursor_sdk";
    }
    void vscode.window.showErrorMessage("AXME Code: failed to save Cursor SDK API key. Check the AXME Code output channel.");
    return "disabled";
  }

  return "disabled";
}

async function promptKey(label: string, placeholder: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `AXME Code — paste ${label}`,
    placeHolder: placeholder,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return "Cannot be empty";
      if (t.length < 20) return "Looks too short to be a valid API key";
      if (/\s/.test(t)) return "API keys do not contain whitespace";
      return null;
    },
  });
  return value?.trim() || undefined;
}

async function runShell(
  binary: string,
  args: string[],
  envExtra: Record<string, string> = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      env: { ...process.env, ...envExtra },
      stdio: "ignore",
    });
    let resolved = false;
    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      resolve(code === 0);
    });
    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      logError(`runShell ${binary} ${args.join(" ")}`, err);
      resolve(false);
    });
  });
}

async function detectCurrentMode(binary: string): Promise<AuditorAuthMode | undefined> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["auth", "status"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.on("exit", () => {
      const m = /Current mode:\s*(\w+)/m.exec(stdout);
      if (!m) return resolve(undefined);
      const mode = m[1];
      if (mode === "subscription" || mode === "api_key" || mode === "cursor_sdk") {
        resolve(mode);
      } else {
        resolve(undefined);
      }
    });
    child.on("error", () => resolve(undefined));
  });
}
