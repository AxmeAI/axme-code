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
import { basename } from "node:path";
import { execFile } from "node:child_process";
import { detectIde, IdeKind } from "./ide-detect.js";
import { findAxmeBinary, findBundledNode } from "./binary-detect.js";
import { registerMcpServer } from "./mcp-register.js";
import { installUserHooks } from "./hooks-install.js";
import { setBundledNode } from "./spawn-binary.js";
import { setExtensionPath as setBundledRuntimePath } from "./bundled-runtime.js";
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

/**
 * POSIX-only preflight: the bundled CLI is a `#!/usr/bin/env node` shim and
 * the MCP server / hooks are spawned by Cursor OUTSIDE the extension host —
 * both need a system Node 20+ on PATH (Windows ships its own node.exe in
 * the .vsix; macOS/Linux do not). Without this check, a Node-less user gets
 * the completely undebuggable "MCP server does not exist" in chat plus
 * silently failing hooks. Returns null when OK, otherwise an actionable
 * problem description. Never throws; a broken `node -v` IS the finding.
 */
function checkSystemNode(): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolveCheck) => {
    execFile("node", ["-v"], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolveCheck(
          "Node.js 20+ was not found on PATH. The AXME MCP server and safety hooks " +
            "cannot start without it. Install Node (https://nodejs.org, or `brew install node` / " +
            "your package manager), then reload the window.",
        );
        return;
      }
      const major = parseInt(String(stdout).trim().replace(/^v/, "").split(".")[0] ?? "", 10);
      if (Number.isFinite(major) && major < 20) {
        resolveCheck(
          `Node.js ${String(stdout).trim()} found, but axme-code targets Node 20+. ` +
            "The MCP server may fail to start — please upgrade Node and reload the window.",
        );
        return;
      }
      resolveCheck(null);
    });
  });
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
  const binary = await runStep(report, "binary", (b) => basename(b) || "ok", async () => {
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

  // Cache the bundled Node.exe path (Windows only). Used by mcp-register,
  // hooks-install, and every spawn through spawnBinary(). On Linux/macOS
  // this resolves to undefined and the shebang shim is executed directly.
  // If we're on Windows and node-windows-x64.exe is missing from the
  // .vsix, downstream spawns throw a clear "reinstall the extension"
  // error rather than failing mysteriously with ENOENT.
  const bundledNode = findBundledNode(context);
  setBundledNode(bundledNode);
  setBundledRuntimePath(context.extensionPath);
  if (process.platform === "win32") {
    log(`  Bundled Node: ${bundledNode ?? "(missing — Windows spawns will fail)"}`);
  }

  // ---- Step 2b: system Node preflight (POSIX only) -------------------------
  // Soft-fail: we record + surface the problem but continue activation —
  // the extension host's PATH is a close proxy for the env Cursor uses to
  // spawn the MCP server, not a perfect one, and a false negative must not
  // brick an otherwise-working install. When Node IS genuinely absent the
  // user now gets an actionable message instead of a dead "MCP server does
  // not exist" chat error with no explanation.
  const nodeProblem = await checkSystemNode();
  if (nodeProblem) {
    report.record("node", false, nodeProblem.slice(0, 80));
    logError("System Node preflight", new Error(nodeProblem));
    void vscode.window
      .showErrorMessage(`AXME Code: ${nodeProblem}`, "Open nodejs.org", "Show output")
      .then((c) => {
        if (c === "Open nodejs.org") void vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org"));
        if (c === "Show output") showOutput();
      });
  } else {
    report.record("node", true, process.platform === "win32" ? "bundled" : "system");
  }

  // ---- Step 3: MCP registration ------------------------------------------
  // We need the workspace folder BEFORE Step 6 — pass it to mcp-register so
  // the server's --workspace flag points at the real project, not Cursor's
  // home-dir cwd. Without this, axme_context called with no project_path
  // defaults to /home/$USER and misses the workspace's .axme-code/ entirely.
  //
  // MCP registration is the load-bearing step: every MCP tool the user
  // expects (axme_context, axme_save_*, axme_safety, ...) depends on it.
  // If this fails, the sidebar / hooks / etc. can technically activate but
  // the user will see "MCP server does not exist" on every chat tool call
  // and have no way to recover from inside the extension. Previously the
  // activation continued silently past an MCP failure, leaving the
  // sidebar showing "ready" while tools were dead. Now we abort with a
  // visible error so the user knows something needs attention.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder?.uri.fsPath;
  const mcpRegistered = await runStep(report, "mcp", () => "registered", async () => {
    const disposable = await registerMcpServer(binary, workspaceRoot);
    context.subscriptions.push(disposable);
    return true;
  });
  if (mcpRegistered === undefined) {
    log("MCP registration failed — aborting activation. See output above for the underlying error.");
    await report.present();
    return;
  }

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
    // retainContextWhenHidden keeps the webview's DOM + JS state alive
    // when the user switches to a different Activity Bar view (Files,
    // Search, etc.) and back. Without it, Cursor disposes the webview
    // on hide and we re-create from scratch on next reveal — losing
    // every live counter, the session block, the auditor dropdown
    // selection. Memory cost is ~1–2 MB per webview, trivial vs the
    // UX win of "everything stays where I left it".
    vscode.window.registerWebviewViewProvider(AxmeSidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => sidebar.dispose() },
    // Hidden command for the rest of the extension to nudge a full
    // sidebar refresh after CLI mutations that the KbWatcher's
    // counts-only signature wouldn't notice (e.g. context-mode flip,
    // config edits). Commands call this with executeCommand right
    // after their CLI subprocess returns success.
    vscode.commands.registerCommand("axme.refreshSidebar", () => sidebar.refreshAll()),
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
  // Both surfaces — sidebar focus + Welcome walkthrough — fire whenever
  // the current workspace is uninitialised. AXME is per-project, so a
  // fresh repo ALWAYS warrants the dashboard + the onboarding. We
  // previously gated walkthrough behind a per-machine globalState flag
  // that survived uninstall+reinstall on some Cursor builds — meaning
  // reinstall users got only the sidebar and never saw the walkthrough
  // again. Tying both triggers to "workspace not initialised" matches
  // when the help is actually useful and stops being shown the moment
  // the user (or the agent via cooperative setup) creates .axme-code/.
  //
  // The 400 ms setTimeout lets the viewsContainer and walkthrough
  // contributions finish registering with the workbench. Calling
  // workbench.view.extension.axme synchronously inside activate() can
  // silently no-op because Cursor wires the contribution graph out of
  // band from extension activation — the delay is invisible to the user
  // and consistently past the registration race.
  setTimeout(() => {
    const workspaceNeedsAxme = !!workspaceFolder && !isAxmeInitialized();
    if (workspaceNeedsAxme) {
      void vscode.commands.executeCommand("workbench.view.extension.axme")
        .then(undefined, (err) => logError("focus sidebar", err));
      void vscode.commands.executeCommand("axme.monitor.focus")
        .then(undefined, () => { /* container-level focus is enough */ });
      void vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        { category: "AxmeAI.axme-code#axme.gettingStarted" },
        false,
      ).then(
        () => log("Discoverability: opened sidebar + walkthrough."),
        (err) => logError("open walkthrough", err),
      );
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
