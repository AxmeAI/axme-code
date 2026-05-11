/**
 * AXME Code — Cursor extension entry point (v0.0.1, Cursor-only).
 *
 * Activation flow:
 *   1. Detect Cursor (vs VS Code or other fork). Bail out with a friendly
 *      message if not running in Cursor.
 *   2. Locate the bundled `axme-code` binary at <extensionPath>/bin/axme-code.
 *   3. Register the MCP server via Cursor's proprietary extension API.
 *   4. Install user-level safety hooks at ~/.cursor/hooks.json.
 *   5. Ensure auditor LLM credential is configured (modal on first run).
 *   6. If the workspace is not initialised yet, offer to run `axme-code setup`.
 *   7. Attach the AXME status bar and register commands.
 *
 * Deactivation disposes the MCP registration (Cursor unregisters the
 * server), the status bar, the FS watcher, and all commands. User-level
 * hooks at ~/.cursor/hooks.json are NOT removed on deactivate — the user
 * can remove them manually if they uninstall the extension. (VS Code's
 * deactivate fires on plain window-close too, so blanket-removing hooks
 * there would be wrong.)
 */

import * as vscode from "vscode";
import { detectIde, IdeKind } from "./ide-detect.js";
import { findAxmeBinary } from "./binary-detect.js";
import { registerMcpServer } from "./mcp-register.js";
import { installUserHooks } from "./hooks-install.js";
import { ensureAuditorAuth } from "./auditor-auth.js";
import { offerSetupIfMissing } from "./setup-controller.js";
import { AxmeStatusBar } from "./status-bar.js";
import { registerCommands } from "./commands.js";
import { log, logError, show as showOutput, dispose as disposeLog } from "./log.js";

declare const __EXTENSION_VERSION__: string;

let statusBar: AxmeStatusBar | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log(`AXME Code v${__EXTENSION_VERSION__} activating…`);

  // ---- Step 1: Cursor gate -------------------------------------------------
  const ide: IdeKind = detectIde();
  log(`  Host IDE: ${ide}`);
  if (ide !== "cursor") {
    log("  Not running in Cursor — extension will not register any tools.");
    void vscode.window
      .showWarningMessage(
        "AXME Code v0.0.1 requires Cursor. VS Code / Copilot / Cline support is " +
          "on the roadmap once Microsoft adds chat-tool interception + chat-end " +
          "lifecycle APIs.",
        "Open output",
      )
      .then((c) => {
        if (c === "Open output") showOutput();
      });
    return;
  }

  // ---- Step 2: binary -----------------------------------------------------
  const binary = await findAxmeBinary(context);
  if (!binary) {
    log("  axme-code binary not found.");
    void vscode.window.showErrorMessage(
      "AXME Code: bundled axme-code binary not found inside this .vsix. " +
        "Please file an issue at github.com/AxmeAI/axme-code/issues. As a " +
        "workaround, install axme-code separately and set `axme.binaryPath`.",
    );
    return;
  }
  log(`  Binary: ${binary}`);

  // ---- Step 3: MCP registration ------------------------------------------
  try {
    const mcpDisposable = await registerMcpServer(binary);
    context.subscriptions.push(mcpDisposable);
  } catch (err) {
    logError("MCP register", err);
    void vscode.window.showErrorMessage(
      `AXME Code: MCP registration failed — ${(err as Error).message}. ` +
        "See AXME Code output channel.",
    );
    // Continue activation so user can still see output + try Reauth / Setup.
  }

  // ---- Step 4: hooks ------------------------------------------------------
  const enableHooks = vscode.workspace
    .getConfiguration("axme")
    .get<boolean>("enableHooks", true);
  if (enableHooks) {
    try {
      installUserHooks("cursor", binary);
    } catch (err) {
      logError("Hooks install", err);
    }
  } else {
    log("Hooks: disabled by axme.enableHooks setting");
  }

  // ---- Step 5: auditor auth ----------------------------------------------
  try {
    await ensureAuditorAuth(binary);
  } catch (err) {
    logError("Auditor auth", err);
  }

  // ---- Step 6: setup offer -----------------------------------------------
  void offerSetupIfMissing(binary, "cursor");

  // ---- Step 7: status bar + commands -------------------------------------
  statusBar = new AxmeStatusBar();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) statusBar.attach(workspaceFolder.uri.fsPath);
  context.subscriptions.push(statusBar);
  context.subscriptions.push(
    ...registerCommands(context, binary, "cursor", statusBar),
  );

  log(`Activation complete. ${context.subscriptions.length} disposables registered.`);
}

export function deactivate(): void {
  log("AXME Code deactivating…");
  // VS Code disposes context.subscriptions automatically. Our singleton
  // output channel is disposed here so the deactivation log line lands
  // before it goes silent.
  disposeLog();
}
