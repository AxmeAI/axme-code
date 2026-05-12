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
import { openStatusWebview } from "./status-webview.js";
import { runReset } from "./reset.js";
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
      // v0.0.2: replace plain-text output dump with a full healthcheck
      // webview (status of binary, MCP, hooks, auth, KB per workspace).
      // The old "axme-code status" output dump is still accessible via the
      // axme.showStatusText fallback command for power users.
      await openStatusWebview(binary);
    }),

    vscode.commands.registerCommand("axme.showStatusText", async () => {
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

    vscode.commands.registerCommand("axme.reset", async () => {
      await runReset();
    }),

    // ----- v0.0.3 sidebar entry points (wired up in follow-up commits) -----
    // These commands exist so the sidebar can route clicks to them without
    // races on activation order. The bodies that drop cooperative prompts
    // into the chat (askAgentSetup, closeSession, addBacklogItem) and the
    // backlog/hooks helpers land in subsequent commits of the same PR.
    vscode.commands.registerCommand("axme.askAgentSetup", async () => {
      void vscode.window.showInformationMessage(
        "AXME: cooperative setup prompt — wired up in upcoming v0.0.3 commit.",
      );
    }),
    vscode.commands.registerCommand("axme.closeSession", async () => {
      void vscode.window.showInformationMessage(
        "AXME: close-session prompt — wired up in upcoming v0.0.3 commit.",
      );
    }),
    vscode.commands.registerCommand("axme.openBacklog", async () => {
      const root = workspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage("AXME Code: open a folder first.");
        return;
      }
      const uri = vscode.Uri.file(join(root, ".axme-code", "backlog"));
      await vscode.commands.executeCommand("revealInExplorer", uri);
    }),
    vscode.commands.registerCommand("axme.addBacklogItem", async () => {
      const root = workspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage("AXME Code: open a folder first.");
        return;
      }
      const title = await vscode.window.showInputBox({
        prompt: "Backlog item title",
        placeHolder: "e.g. Add semantic search reranker",
        validateInput: (v) => (v && v.trim().length >= 3 ? null : "Title must be at least 3 chars"),
      });
      if (!title) return;
      const priority = await vscode.window.showQuickPick(
        [
          { label: "high",   description: "Block other work" },
          { label: "medium", description: "Standard (default)" },
          { label: "low",    description: "Nice-to-have" },
        ],
        { placeHolder: "Priority" },
      );
      if (!priority) return;
      const child = spawn(
        binary,
        ["backlog", "add", "--title", title, "--priority", priority.label],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "", err = "";
      child.stdout.on("data", (c) => (out += c.toString()));
      child.stderr.on("data", (c) => (err += c.toString()));
      const code: number = await new Promise((res) => {
        child.on("exit", (c) => res(c ?? 1));
        child.on("error", () => res(1));
      });
      if (code === 0) {
        const id = out.trim().split("\n").pop() ?? "(unknown)";
        void vscode.window.showInformationMessage(`AXME: added ${id} — ${title}`);
      } else {
        logError("backlog add", new Error(err || `exit ${code}`));
        void vscode.window.showErrorMessage(`AXME: failed to add backlog item — ${err.trim() || `exit ${code}`}`);
      }
    }),
    vscode.commands.registerCommand("axme.reinstallHooks", async () => {
      void vscode.window.showInformationMessage(
        "AXME: hooks reinstall — wired up in upcoming v0.0.3 commit.",
      );
    }),
  ];
}
