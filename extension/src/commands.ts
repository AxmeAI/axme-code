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
import { deliverChatPrompt, PROMPT_SETUP } from "./chat-prompt.js";
import { installUserHooks } from "./hooks-install.js";
import { log, logError, show as showOutput } from "./log.js";

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/** Reveal a folder in the Explorer panel. If the folder doesn't exist
 *  yet (pre-setup), surface a hint instead of an error so the user
 *  understands the state rather than seeing a raw "not found". */
async function revealOrHint(
  root: string | undefined,
  relPath: string,
  label: string,
): Promise<void> {
  if (!root) {
    void vscode.window.showWarningMessage("AXME Code: open a folder first.");
    return;
  }
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    void vscode.window.showInformationMessage(
      `AXME Code: no ${label} yet — run setup or ask the agent to save some first.`,
    );
    return;
  }
  await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(abs));
}

/** Same idea but for a single file — opens it in the editor instead of
 *  revealing a folder. */
async function openOrHint(
  root: string | undefined,
  relPath: string,
  label: string,
): Promise<void> {
  if (!root) {
    void vscode.window.showWarningMessage("AXME Code: open a folder first.");
    return;
  }
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    void vscode.window.showInformationMessage(
      `AXME Code: no ${label} yet — run setup or ask the agent to save some first.`,
    );
    return;
  }
  const doc = await vscode.workspace.openTextDocument(abs);
  await vscode.window.showTextDocument(doc);
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
      let lastLine = "";
      const exitCode: number = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "AXME Code: reindexing semantic search",
          cancellable: false,
        },
        () =>
          new Promise<number>((resolve) => {
            const child = spawn(binary, ["reindex", root], { cwd: root });
            child.stdout.on("data", (c) => {
              const s = String(c).trimEnd();
              if (s) lastLine = s;
              log(`reindex: ${s}`);
            });
            child.stderr.on("data", (c) => log(`reindex stderr: ${String(c).trimEnd()}`));
            child.on("error", (err) => { logError("reindex", err); resolve(1); });
            child.on("exit", (code) => resolve(code ?? 1));
          }),
      );
      // The previous version was effectively silent on success — progress
      // toast vanished, no terminal feedback. Now we surface the last stdout
      // line ("Reindexed N entries." or similar) as a confirmation toast so
      // the user knows the click actually did something. Failures still
      // open the output channel.
      if (exitCode === 0) {
        void vscode.window.showInformationMessage(
          `AXME Code: ${lastLine || "reindex complete"}`,
        );
      } else {
        void vscode.window.showErrorMessage(
          `AXME Code: reindex failed (exit ${exitCode}). See output channel.`,
        );
        showOutput();
      }
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

    // ----- v0.0.3 sidebar entry points -----
    // Commands surfaced by the sidebar webview. Cooperative prompts copy
    // structured agent instructions to the clipboard; users paste them
    // into the active chat (no fresh-tab spawn — that was bad UX).
    vscode.commands.registerCommand("axme.askAgentSetup", async () => {
      await deliverChatPrompt({ label: "setup prompt", body: PROMPT_SETUP });
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
      const ok = installUserHooks("cursor", binary);
      if (ok) {
        void vscode.window.showInformationMessage(
          "AXME: hooks reinstalled in ~/.cursor/hooks.json. Restart Cursor to take effect.",
        );
      } else {
        void vscode.window.showErrorMessage(
          "AXME: failed to reinstall hooks — see AXME Code output channel.",
        );
        showOutput();
      }
    }),

    // ----- v0.0.3 sidebar KB-counter click targets -------------------------
    // Each counter in the Knowledge base section routes to one of these.
    // Folders open in the Explorer panel; single files open in the editor.
    // If the target doesn't exist yet (workspace pre-setup), we surface a
    // gentle hint instead of an error — the agent might be just about to
    // create it via the cooperative setup flow.
    vscode.commands.registerCommand("axme.openMemoryFolder", async () => {
      await revealOrHint(workspaceRoot(), join(".axme-code", "memory"), "memories");
    }),
    vscode.commands.registerCommand("axme.openDecisionsFolder", async () => {
      await revealOrHint(workspaceRoot(), join(".axme-code", "decisions"), "decisions");
    }),
    vscode.commands.registerCommand("axme.openSafetyRules", async () => {
      await openOrHint(workspaceRoot(), join(".axme-code", "safety", "rules.yaml"), "safety rules");
    }),
    vscode.commands.registerCommand("axme.openQuestions", async () => {
      await openOrHint(workspaceRoot(), join(".axme-code", "open-questions.md"), "open questions");
    }),
  ];
}
