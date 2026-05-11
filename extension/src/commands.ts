/**
 * Command palette entries.
 *
 * Each command's full implementation lives in a dedicated file (setup-
 * controller.ts, auditor-auth.ts). This module just registers them and
 * routes to the right handler.
 */

import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IdeKind } from "./ide-detect.js";
import { runSetup } from "./setup-controller.js";
import { ensureAuditorAuth } from "./auditor-auth.js";
import { AxmeStatusBar } from "./status-bar.js";
import { log, logError, show as showOutput } from "./log.js";

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  binary: string,
  ide: IdeKind,
  statusBar: AxmeStatusBar,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("axme.setup", async () => {
      await runSetup(binary, ide);
    }),

    vscode.commands.registerCommand("axme.reauthAuditor", async () => {
      // Force re-prompt by stubbing the saved state via env override on the
      // `auth status` call would be ugly — simplest: shell out to
      // `axme-code auth` (interactive) or run our prompt flow regardless.
      // We re-run the prompt and let the user pick again.
      await ensureAuditorAuth(binary);
    }),

    vscode.commands.registerCommand("axme.reindex", async () => {
      const root = workspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage("AXME Code: open a folder first.");
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "AXME Code: reindexing semantic search",
          cancellable: false,
        },
        () =>
          new Promise<void>((resolve) => {
            const child = spawn(binary, ["reindex", root], { cwd: root });
            child.stdout.on("data", (c) => log(`reindex: ${String(c).trimEnd()}`));
            child.stderr.on("data", (c) => log(`reindex stderr: ${String(c).trimEnd()}`));
            child.on("error", (err) => { logError("reindex", err); resolve(); });
            child.on("exit", (code) => {
              if (code !== 0) showOutput();
              resolve();
            });
          }),
      );
    }),

    vscode.commands.registerCommand("axme.showStatus", async () => {
      const root = workspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage("AXME Code: open a folder first.");
        return;
      }
      const child = spawn(binary, ["status", root], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => (out += c.toString()));
      child.stderr.on("data", (c) => (out += c.toString()));
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        child.on("error", () => resolve());
      });
      log(`axme-code status output:\n${out.trimEnd()}`);
      showOutput();
    }),

    vscode.commands.registerCommand("axme.openDashboard", async () => {
      const root = workspaceRoot();
      if (!root) return;
      const dir = join(root, ".axme-code");
      if (!existsSync(dir)) {
        void vscode.window.showInformationMessage(
          "AXME Code: workspace not initialised. Run AXME: Setup first.",
        );
        return;
      }
      const uri = vscode.Uri.file(dir);
      await vscode.commands.executeCommand("revealInExplorer", uri);
    }),

    vscode.commands.registerCommand("axme.showRecentDecisions", async () => {
      const items = statusBar.recentDecisions().map((d) => ({
        label: `${d.id}: ${d.title}`,
        description: d.path,
        path: d.path,
      }));
      if (items.length === 0) {
        void vscode.window.showInformationMessage("AXME Code: no decisions yet.");
        return;
      }
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Recent AXME decisions (most recent first)",
      });
      if (picked) {
        const doc = await vscode.workspace.openTextDocument(picked.path);
        await vscode.window.showTextDocument(doc);
      }
    }),
  ];
}
