/**
 * Command palette entries.
 *
 * Each command's full implementation lives in a dedicated file (setup-
 * controller.ts, auditor-auth.ts). This module just registers them and
 * routes to the right handler.
 */

import * as vscode from "vscode";
import { spawnBinary } from "./spawn-binary.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { IdeKind } from "./ide-detect.js";
import { runSetup } from "./setup-controller.js";
import { ensureAuditorAuth } from "./auditor-auth.js";
import { AxmeStatusBar } from "./status-bar.js";
import { openStatusWebview } from "./status-webview.js";
import { runReset } from "./reset.js";
import { deliverChatPrompt, PROMPT_SETUP } from "./chat-prompt.js";
import { installUserHooks } from "./hooks-install.js";
import { enableSearchMode, disableSearchMode } from "./search-mode.js";
import { log, logError, show as showOutput } from "./log.js";

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/** Spawn a CLI subcommand, capture stdout+stderr, return text + exit
 *  code. Helper for the palette commands that need to surface CLI text
 *  output (stats / self-test / audit-kb / cleanup). */
async function runCli(
  binary: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    const child = spawnBinary(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (c) => (out += c.toString()));
    child.stderr!.on("data", (c) => (out += c.toString()));
    child.on("error", () => resolve({ code: 1, text: out }));
    child.on("exit", (code) => resolve({ code: code ?? 0, text: out }));
  });
}

/** Return the most-recently-modified file in `dir` matching `pattern`,
 *  or undefined if none. Used to find "the latest handoff" / "the
 *  latest audit log" without enumerating timestamps in the caller. */
function pickLatest(dir: string, pattern: RegExp): string | undefined {
  if (!existsSync(dir)) return undefined;
  let best: { path: string; mtime: number } | undefined;
  try {
    for (const f of readdirSync(dir)) {
      if (!pattern.test(f)) continue;
      const p = join(dir, f);
      try {
        const m = statSync(p).mtimeMs;
        if (!best || m > best.mtime) best = { path: p, mtime: m };
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return best?.path;
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
            const child = spawnBinary(binary, ["reindex", root], { cwd: root });
            child.stdout!.on("data", (c) => {
              const s = String(c).trimEnd();
              if (s) lastLine = s;
              log(`reindex: ${s}`);
            });
            child.stderr!.on("data", (c) => log(`reindex stderr: ${String(c).trimEnd()}`));
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
      const child = spawnBinary(binary, ["status", root], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout!.on("data", (c) => (out += c.toString()));
      child.stderr!.on("data", (c) => (out += c.toString()));
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
    vscode.commands.registerCommand("axme.changeBacklogStatus", async (id: string) => {
      if (!id) return;
      const root = workspaceRoot();
      if (!root) { void vscode.window.showWarningMessage("AXME Code: open a folder first."); return; }
      const picked = await vscode.window.showQuickPick(
        [
          { label: "open",        description: "back to the top of the queue" },
          { label: "in-progress", description: "actively being worked on" },
          { label: "blocked",     description: "waiting on something external" },
          { label: "done",        description: "completed" },
        ],
        { placeHolder: `Set status of ${id}` },
      );
      if (!picked) return;
      // backlog has no MCP write path with status — but the CLI's update
      // function reads/writes the file atomically. Shell out.
      const child = spawnBinary(
        binary,
        ["backlog", "update", "--id", id, "--status", picked.label],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      let err = "";
      child.stderr!.on("data", (c) => (err += c.toString()));
      const code: number = await new Promise((res) => {
        child.on("exit", (c) => res(c ?? 1));
        child.on("error", () => res(1));
      });
      if (code === 0) {
        void vscode.window.showInformationMessage(`AXME: ${id} → ${picked.label}`);
      } else {
        void vscode.window.showErrorMessage(`AXME: failed to update ${id} — ${err.trim() || `exit ${code}`}`);
      }
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
      const child = spawnBinary(
        binary,
        ["backlog", "add", "--title", title, "--priority", priority.label],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "", err = "";
      child.stdout!.on("data", (c) => (out += c.toString()));
      child.stderr!.on("data", (c) => (err += c.toString()));
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

    // ----- v0.0.3 palette + sidebar status commands -------------------------
    // Each maps to one of the core CLI subcommands or `.axme-code/` files
    // that previously had no UI surface in the extension. The patterns:
    //   - openOrHint / revealOrHint for static files / folders
    //   - runCli for CLI subcommands that produce text output
    //   - pickLatest for "most recent of N files" (handoff, audit log)
    vscode.commands.registerCommand("axme.showLastHandoff", async () => {
      const root = workspaceRoot();
      if (!root) { void vscode.window.showWarningMessage("AXME Code: open a folder first."); return; }
      const path = pickLatest(join(root, ".axme-code", "plans"), /^handoff-.*\.md$/);
      if (!path) { void vscode.window.showInformationMessage("AXME Code: no handoff yet — close a session to create one."); return; }
      const doc = await vscode.workspace.openTextDocument(path);
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand("axme.showAuditLog", async () => {
      const root = workspaceRoot();
      if (!root) { void vscode.window.showWarningMessage("AXME Code: open a folder first."); return; }
      const path = pickLatest(join(root, ".axme-code", "audit-worker-logs"), /\.log$/);
      if (!path) { void vscode.window.showInformationMessage("AXME Code: no audit logs yet — background auditor hasn't run."); return; }
      const doc = await vscode.workspace.openTextDocument(path);
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand("axme.showWorklog", async () => {
      await openOrHint(workspaceRoot(), join(".axme-code", "worklog.md"), "worklog");
    }),
    vscode.commands.registerCommand("axme.showTestPlan", async () => {
      await openOrHint(workspaceRoot(), join(".axme-code", "test-plan.yaml"), "test plan");
    }),
    vscode.commands.registerCommand("axme.showDeployStaging", async () => {
      await openOrHint(workspaceRoot(), join(".axme-code", "deploy", "staging-checklist.yaml"), "staging deploy checklist");
    }),
    vscode.commands.registerCommand("axme.showDeployProd", async () => {
      await openOrHint(workspaceRoot(), join(".axme-code", "deploy", "prod-checklist.yaml"), "production deploy checklist");
    }),
    vscode.commands.registerCommand("axme.showFilesChanged", async () => {
      const root = workspaceRoot();
      if (!root) { void vscode.window.showWarningMessage("AXME Code: open a folder first."); return; }
      // Read all session metas, dedupe filesChanged across all owned by the
      // current PID-tree, then show in a QuickPick that opens the picked
      // file in the editor on selection.
      const sessionsDir = join(root, ".axme-code", "sessions");
      if (!existsSync(sessionsDir)) {
        void vscode.window.showInformationMessage("AXME Code: no sessions yet.");
        return;
      }
      const { readdirSync, readFileSync } = await import("node:fs");
      const fileSet = new Set<string>();
      for (const sid of readdirSync(sessionsDir)) {
        const metaPath = join(sessionsDir, sid, "meta.json");
        if (!existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { filesChanged?: string[] };
          for (const f of meta.filesChanged ?? []) fileSet.add(f);
        } catch { /* skip */ }
      }
      if (fileSet.size === 0) {
        void vscode.window.showInformationMessage("AXME Code: no file changes recorded across sessions.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        Array.from(fileSet).sort().map((f) => ({ label: basename(f) || f, description: f, path: f })),
        { placeHolder: `Files changed across all sessions (${fileSet.size}) — pick to open` },
      );
      if (!picked) return;
      try {
        const doc = await vscode.workspace.openTextDocument(picked.path);
        await vscode.window.showTextDocument(doc);
      } catch (e) {
        void vscode.window.showWarningMessage(`AXME: couldn't open ${picked.path} — it may have been deleted.`);
      }
    }),
    vscode.commands.registerCommand("axme.selfTest", async () => {
      const root = workspaceRoot() ?? process.cwd();
      const out = await runCli(binary, ["self-test"], root);
      log(`self-test:\n${out.text}`);
      showOutput();
      if (out.code === 0) {
        void vscode.window.showInformationMessage("AXME: self-test passed (see output).");
      } else {
        void vscode.window.showErrorMessage(`AXME: self-test failed (exit ${out.code}) — see output.`);
      }
    }),
    vscode.commands.registerCommand("axme.auditKb", async () => {
      const root = workspaceRoot();
      if (!root) { void vscode.window.showWarningMessage("AXME Code: open a folder first."); return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "AXME: running knowledge-base audit", cancellable: false },
        async () => {
          const out = await runCli(binary, ["audit-kb", root], root);
          log(`audit-kb:\n${out.text}`);
          if (out.code !== 0) showOutput();
        },
      );
      void vscode.window.showInformationMessage("AXME: KB audit finished. Reports in .axme-code/kb-audit/.");
    }),
    vscode.commands.registerCommand("axme.showStats", async () => {
      const root = workspaceRoot() ?? process.cwd();
      const out = await runCli(binary, ["stats", root], root);
      log(`stats:\n${out.text}`);
      showOutput();
    }),
    vscode.commands.registerCommand("axme.enableSemanticSearch", async () => {
      const root = workspaceRoot();
      if (!root) { void vscode.window.showWarningMessage("AXME Code: open a folder first."); return; }
      await enableSearchMode(binary, root);
    }),
    vscode.commands.registerCommand("axme.disableSemanticSearch", async () => {
      const root = workspaceRoot();
      if (!root) { void vscode.window.showWarningMessage("AXME Code: open a folder first."); return; }
      await disableSearchMode(binary, root);
    }),
    vscode.commands.registerCommand("axme.cleanup", async () => {
      const root = workspaceRoot() ?? process.cwd();
      const confirm = await vscode.window.showWarningMessage(
        "AXME: clean up orphaned session state (mappings whose Cursor process is dead, abandoned active-sessions, etc.)?",
        { modal: true },
        "Run cleanup",
      );
      if (confirm !== "Run cleanup") return;
      const out = await runCli(binary, ["cleanup", root], root);
      log(`cleanup:\n${out.text}`);
      if (out.code === 0) void vscode.window.showInformationMessage("AXME: cleanup done.");
      else { void vscode.window.showErrorMessage("AXME: cleanup failed — see output."); showOutput(); }
    }),
  ];
}
