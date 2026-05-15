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
import { spawnBinary } from "./spawn-binary.js";
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
    "AXME Code session auditor needs an LLM credential. It runs once at the end of each chat to " +
      "extract memories, decisions, and safety rules from your conversation. Pick a provider:\n\n" +
      "• Anthropic API key — pay-per-token via console.anthropic.com\n" +
      "• Cursor SDK key — uses your existing Cursor account (Pro users have included quota)\n" +
      "• Skip — MCP tools and safety hooks still work; just no automatic memory extraction",
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
    const key = await collectKey({
      label: "Anthropic API key",
      placeholder: "sk-ant-api03-...",
      dashboardUrl: "https://console.anthropic.com/settings/keys",
      dashboardLabel: "Open console.anthropic.com → API Keys",
      instruction:
        "On console.anthropic.com → API Keys, click 'Create Key', copy the key (starts with sk-ant-), come back here and paste.",
    });
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
    const key = await collectKey({
      label: "Cursor SDK API key",
      placeholder: "key_...",
      dashboardUrl: "https://cursor.com/dashboard/integrations",
      dashboardLabel: "Open cursor.com/dashboard/integrations",
      instruction:
        "On the Integrations page, click 'Create new API key', copy the key (starts with key_), come back here and paste. Billing for auditor calls goes through your Cursor account (Pro users have included quota).",
    });
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

/**
 * Two-step credential prompt:
 *   1. Show info message with "Open dashboard" button → opens browser.
 *      User leaves Cursor, generates a key on the provider's site,
 *      copies it, comes back. Cursor input box stays open
 *      (ignoreFocusOut: true) so the paste lands when they return.
 *   2. Show password-style input box with the generation instructions
 *      as `prompt` text below the title.
 *
 * If the user picks "I already have a key", step 1 is skipped.
 */
async function collectKey(opts: {
  label: string;
  placeholder: string;
  dashboardUrl: string;
  dashboardLabel: string;
  instruction: string;
}): Promise<string | undefined> {
  const action = await vscode.window.showInformationMessage(
    `AXME Code needs your ${opts.label}. ${opts.instruction}`,
    { modal: false },
    opts.dashboardLabel,
    "I already have a key — let me paste",
    "Cancel",
  );

  if (action === "Cancel" || action === undefined) return undefined;

  if (action === opts.dashboardLabel) {
    try {
      await vscode.env.openExternal(vscode.Uri.parse(opts.dashboardUrl));
      log(`Auditor auth: opened ${opts.dashboardUrl} in browser`);
    } catch (err) {
      logError(`openExternal(${opts.dashboardUrl})`, err);
    }
    // Brief delay so the browser tab is visible before our input box steals
    // focus back. User can still ignore and continue in the browser; we keep
    // ignoreFocusOut: true so the input box stays alive.
    await new Promise((r) => setTimeout(r, 800));
  }

  const value = await vscode.window.showInputBox({
    title: `AXME Code — paste ${opts.label}`,
    prompt: opts.instruction,
    placeHolder: opts.placeholder,
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
    const child = spawnBinary(binary, args, {
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

export async function detectCurrentMode(binary: string): Promise<AuditorAuthMode | undefined> {
  return new Promise((resolve) => {
    const child = spawnBinary(binary, ["auth", "status"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk.toString()));
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
