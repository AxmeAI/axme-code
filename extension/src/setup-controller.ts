/**
 * Wraps `axme-code setup --ide=<ide>` for the current workspace.
 *
 * On extension activation: if the workspace folder is missing
 * `.axme-code/`, show a non-modal info notification with a "Run setup"
 * button. On click — execute setup with progress UI, stream output to
 * the AXME Code output channel.
 *
 * The same flow is exposed as the `AXME: Setup` command for explicit
 * invocation later.
 */

import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IdeKind } from "./ide-detect.js";
import { log, logError, show as showOutput } from "./log.js";

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

export function isAxmeInitialized(): boolean {
  const root = workspaceRoot();
  if (!root) return false;
  return existsSync(join(root, ".axme-code"));
}

export async function offerSetupIfMissing(binary: string, ide: IdeKind): Promise<void> {
  if (isAxmeInitialized()) return;
  const root = workspaceRoot();
  if (!root) return;

  const choice = await vscode.window.showInformationMessage(
    `AXME Code is not initialised in ${root.split("/").pop()}. Run setup now?`,
    "Run setup",
    "Not now",
  );
  if (choice !== "Run setup") return;
  await runSetup(binary, ide);
}

export async function runSetup(binary: string, ide: IdeKind): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage("AXME Code: open a folder first.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "AXME Code: running setup",
      cancellable: false,
    },
    async (progress) => {
      const args = ["setup", root, "--ide", ide];
      log(`setup: spawn ${binary} ${args.join(" ")}`);
      progress.report({ message: "scanning project + writing .axme-code/ ..." });

      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn(binary, args, {
          cwd: root,
          env: { ...process.env, AXME_TELEMETRY_DISABLED: "1" },
        });
        child.stdout.on("data", (chunk) => log(`setup stdout: ${String(chunk).trimEnd()}`));
        child.stderr.on("data", (chunk) => log(`setup stderr: ${String(chunk).trimEnd()}`));
        child.on("error", (err) => {
          logError("setup spawn", err);
          resolve(1);
        });
        child.on("exit", (code) => resolve(code ?? 1));
      });

      if (exitCode === 0) {
        progress.report({ message: "done" });
        const open = await vscode.window.showInformationMessage(
          "AXME Code setup complete. Open a new chat to start using axme tools.",
          "Show output",
          "Dismiss",
        );
        if (open === "Show output") showOutput();
      } else {
        void vscode.window.showErrorMessage(
          `AXME Code setup failed (exit ${exitCode}). Check the AXME Code output channel.`,
        );
        showOutput();
      }
    },
  );
}
