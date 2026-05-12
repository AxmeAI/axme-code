/**
 * AXME Code — Cursor extension entry point (v0.0.2, Cursor-only).
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
 * Every step's outcome is recorded in an ActivationReport; at the end we
 * show a single summary toast with ✓/✗ per step so the user can see at a
 * glance that everything is wired up (or which step needs attention).
 * Without this, partial installs used to fail silently — the user only
 * noticed hours later when a safety hook didn't fire or an audit didn't
 * run.
 *
 * Deactivation disposes the MCP registration (Cursor unregisters the
 * server), the status bar, the FS watcher, and all commands. User-level
 * hooks at ~/.cursor/hooks.json are NOT removed on deactivate — the user
 * can clear them via `AXME: Reset` command if uninstalling.
 */

import * as vscode from "vscode";
import { detectIde, IdeKind } from "./ide-detect.js";
import { findAxmeBinary } from "./binary-detect.js";
import { registerMcpServer } from "./mcp-register.js";
import { installUserHooks } from "./hooks-install.js";
import { ensureAuditorAuth } from "./auditor-auth.js";
import { isAxmeInitialized } from "./setup-controller.js";
import { AxmeStatusBar } from "./status-bar.js";
import { registerCommands } from "./commands.js";
import { readCounts } from "./kb-watcher.js";
import { ActivationReport, StepKind } from "./activation-report.js";
import { AxmeSidebarProvider } from "./sidebar-webview.js";
import { installAuditorModeMirror, currentAuditorMode } from "./auditor-mode-mirror.js";
import { log, logError, show as showOutput, dispose as disposeLog } from "./log.js";

declare const __EXTENSION_VERSION__: string;

let statusBar: AxmeStatusBar | undefined;

/**
 * Run an activation step inside a try/catch. On failure: record the step
 * as failed in the report AND surface a non-modal warning notification
 * with a [Show output] button so the user is not left guessing. The
 * activation flow continues past the failure — partial functionality is
 * better than total failure (e.g. MCP registered but hooks failed → user
 * still gets axme tools, just no machine-wide safety blocks).
 */
async function runStep<T>(
  report: ActivationReport,
  kind: StepKind,
  successDetail: (result: T) => string,
  body: () => Promise<T>,
): Promise<T | undefined> {
  try {
    const result = await body();
    report.record(kind, true, successDetail(result));
    return result;
  } catch (err) {
    logError(`Step ${kind}`, err);
    report.record(kind, false, (err as Error).message.slice(0, 80));
    void vscode.window
      .showWarningMessage(
        `AXME Code: ${kind} step failed — ${(err as Error).message}`,
        "Show output",
      )
      .then((c) => { if (c === "Show output") showOutput(); });
    return undefined;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log(`AXME Code v${__EXTENSION_VERSION__} activating…`);

  // ---- Step 1: Cursor gate -----------------------------------------------
  const ide: IdeKind = detectIde();
  log(`  Host IDE: ${ide}`);
  if (ide !== "cursor") {
    log("  Not running in Cursor — extension will not register any tools.");
    void vscode.window
      .showWarningMessage(
        "AXME Code v0.0.x requires Cursor. VS Code / Copilot / Cline support is " +
          "on the roadmap once Microsoft adds chat-tool interception + chat-end " +
          "lifecycle APIs.",
        "Open output",
      )
      .then((c) => {
        if (c === "Open output") showOutput();
      });
    return;
  }

  const report = new ActivationReport();

  // ---- Step 2: binary detection ------------------------------------------
  const binary = await runStep(report, "binary", (b) => b.split("/").pop() ?? "ok", async () => {
    const path = await findAxmeBinary(context);
    if (!path) {
      throw new Error(
        "bundled axme-code binary not found inside this .vsix. " +
          "Reinstall the extension; if the problem persists, file an issue.",
      );
    }
    log(`  Binary: ${path}`);
    return path;
  });
  if (!binary) {
    // Binary missing is fatal — every other step needs it. Show summary
    // anyway so user sees the failure in toast form.
    await report.present();
    return;
  }

  // ---- Step 3: MCP registration ------------------------------------------
  // We need the workspace folder BEFORE Step 6 — pass it to mcp-register so
  // the server's --workspace flag points at the real project, not Cursor's
  // home-dir cwd. Without this, axme_context called with no project_path
  // defaults to /home/$USER and misses the workspace's .axme-code/ entirely.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder?.uri.fsPath;
  await runStep(report, "mcp", () => "registered", async () => {
    const disposable = await registerMcpServer(binary, workspaceRoot);
    context.subscriptions.push(disposable);
  });

  // ---- Step 4: hooks ------------------------------------------------------
  const enableHooks = vscode.workspace
    .getConfiguration("axme")
    .get<boolean>("enableHooks", true);
  if (enableHooks) {
    await runStep(report, "hooks", () => "user-level", async () => {
      const ok = installUserHooks("cursor", binary);
      if (!ok) throw new Error("hooks install returned false");
    });
  } else {
    log("Hooks: disabled by axme.enableHooks setting");
    report.record("hooks", true, "disabled by setting");
  }

  // ---- Step 4b: mirror auditor mode to disk for CORE hooks ---------------
  context.subscriptions.push(installAuditorModeMirror());

  // ---- Step 5: auditor auth ----------------------------------------------
  // Only run the credential modal when the user has opted INTO background
  // mode. Cooperative mode never spawns a separate LLM process and
  // therefore needs no credential — this is the v0.0.3 default for fresh
  // Cursor installs, eliminating the most-complained-about modal in the
  // activation flow.
  if (currentAuditorMode() === "background") {
    await runStep(report, "auth", (mode) => mode ?? "?", async () => {
      const mode = await ensureAuditorAuth(binary);
      return mode;
    });
  } else {
    report.record("auth", true, `skipped (auditor mode: ${currentAuditorMode()})`);
  }

  // ---- Step 6: setup status record (no toast — sidebar owns this) --------
  // Earlier versions fired a corner notification ("Run setup now?") via
  // offerSetupIfMissing here. After we shipped the sidebar with explicit
  // [Ask agent to setup] / [Run setup with API key] buttons + the
  // walkthrough's setup step + the MCP server's PROJECT SETUP REQUIRED
  // instruction the agent reads on first chat, that toast became
  // redundant and visually confusing (three surfaces all offering "Run
  // setup"). Now we just record the state and let the sidebar /
  // walkthrough surface the action. workspaceFolder was resolved in Step 3.
  if (workspaceFolder) {
    const initialized = isAxmeInitialized();
    if (initialized) {
      const counts = readCounts(workspaceFolder.uri.fsPath);
      report.record("setup", true, `${counts.decisions} dec, ${counts.memories} mems`);
    } else {
      report.record("setup", true, "pending user action");
    }
    // Drive the "Set up the workspace" walkthrough step's completion event.
    // VS Code listens for onContext: matches the moment this key flips true.
    void vscode.commands.executeCommand("setContext", "axme.workspaceInitialized", initialized);
  } else {
    report.record("setup", true, "no workspace open");
    void vscode.commands.executeCommand("setContext", "axme.workspaceInitialized", false);
  }

  // ---- Step 7: status bar + sidebar + commands ---------------------------
  statusBar = new AxmeStatusBar();
  if (workspaceFolder) statusBar.attach(workspaceFolder.uri.fsPath);
  context.subscriptions.push(statusBar);

  // Sidebar provider — primary always-visible surface. Built before
  // registerCommands so any command can postMessage to it directly. The
  // initial state captures activation flags so the user sees them on
  // first reveal even if KbWatcher hasn't fired yet.
  const auditorMode: "cooperative" | "background" = currentAuditorMode();
  const sidebar = new AxmeSidebarProvider(context, {
    setupDone: workspaceFolder ? isAxmeInitialized() : false,
    auditorMode,
    hooksOk: !report.failedSteps().some((s) => s.kind === "hooks"),
    isCursor: true,
  });
  sidebar.attach(workspaceFolder?.uri.fsPath, binary);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AxmeSidebarProvider.viewType, sidebar),
    { dispose: () => sidebar.dispose() },
  );

  context.subscriptions.push(
    ...registerCommands(context, binary, "cursor", statusBar),
  );

  // ---- Step 7b: reflect report state in status bar -----------------------
  // The corner notification toast from report.present() auto-dismisses
  // after 5s and is easy to miss. The status bar is always visible —
  // setting it to "Setup required" (yellow) or "Activation failed" (red)
  // when something needs attention is the user's continuous reminder.
  if (report.hasFailure()) {
    const labels = report.failedSteps().map((s) => s.kind).join(", ");
    statusBar.setError(`${labels} failed`);
  } else if (workspaceFolder && !isAxmeInitialized()) {
    statusBar.setAttention("Setup required");
  }

  // ---- Step 7c: discoverability -----------------------------------------
  // Two separate triggers — earlier we conflated them under a single
  // globalState gate and reinstall-after-uninstall users got nothing
  // (their globalState flag survived the uninstall on some Cursor builds).
  //
  //   1. Sidebar focus — fire whenever the current workspace is NOT
  //      initialised yet. AXME being per-project means a fresh repo
  //      ALWAYS needs to discover the sidebar; doing this every time the
  //      user opens a new uninitialised workspace is correct behaviour,
  //      not noise. (Initialised workspaces don't re-focus on every
  //      activation — that would hijack the active view.)
  //   2. Welcome walkthrough — fire once per user (globalState) on the
  //      very first activation. We do NOT want the walkthrough popping up
  //      every time the user installs the .vsix in a new repo.
  //
  // The setTimeout lets the view container finish registering before we
  // ask Cursor to focus it — without the delay the command sometimes
  // no-ops because the contribution graph isn't ready yet.
  setTimeout(() => {
    const workspaceNeedsAxme = !!workspaceFolder && !isAxmeInitialized();
    if (workspaceNeedsAxme) {
      void vscode.commands.executeCommand("workbench.view.extension.axme")
        .then(undefined, (err) => logError("focus sidebar", err));
      void vscode.commands.executeCommand("axme.monitor.focus")
        .then(undefined, () => { /* container-level focus is enough */ });
    }

    const FIRST_RUN_KEY = "axme.firstRunComplete";
    if (!context.globalState.get<boolean>(FIRST_RUN_KEY)) {
      void vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        { category: "AxmeAI.axme-code#axme.gettingStarted" },
        false,
      ).then(
        () => log("First-run: opened Getting Started walkthrough."),
        (err) => logError("open walkthrough", err),
      );
      void context.globalState.update(FIRST_RUN_KEY, true);
    }
  }, 400);

  log(`Activation complete. ${context.subscriptions.length} disposables registered.`);

  // ---- Step 8: present summary -------------------------------------------
  await report.present();
}

export function deactivate(): void {
  log("AXME Code deactivating…");
  // VS Code disposes context.subscriptions automatically. Our singleton
  // output channel is disposed here so the deactivation log line lands
  // before it goes silent.
  disposeLog();
}
