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
import { spawnBinary } from "./spawn-binary.js";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { IdeKind } from "./ide-detect.js";
import { detectCurrentMode, ensureAuditorAuth } from "./auditor-auth.js";
import { log, logError, show as showOutput } from "./log.js";

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

export function isAxmeInitialized(rootOverride?: string): boolean {
  const root = rootOverride ?? workspaceRoot();
  if (!root) return false;
  // The directory alone is NOT a setup-complete signal: enabling
  // semantic search runs `axme-code config set context.mode search`
  // which writes .axme-code/config.yaml as a side effect even when
  // setup has never run. Pre-flight reindex of search-mode does the
  // same for .axme-code/_index/. We need a marker that's only ever
  // created by actual setup OR by the cooperative auto-bootstrap that
  // fires from the first axme_save_memory / axme_save_decision call.
  //
  // oracle/stack.md fits: it's written by:
  //   - tools/init.ts writeOracleFiles (API-key setup's LLM scanner)
  //   - tools/init.ts presets path (deterministic fallback if no LLM)
  //   - storage/oracle.ts ensureOracleBootstrapped (called from
  //     axme_save_memory / axme_save_decision MCP tools after first save)
  // None of those fire during pure "enable semantic search" — so absence
  // of oracle/stack.md correctly reflects "setup has not run yet".
  const axmeDir = join(root, ".axme-code");
  if (!existsSync(axmeDir)) return false;
  if (existsSync(join(axmeDir, "oracle", "stack.md"))) return true;
  // Belt-and-braces: also accept any saved decision (D-NNN-*.md) — covers
  // sessions where the agent saved decisions but for some reason the
  // oracle bootstrap was suppressed.
  try {
    const decisions = readdirSync(join(axmeDir, "decisions"));
    if (decisions.some((f) => /^D-\d+-.*\.md$/.test(f))) return true;
  } catch { /* directory missing or unreadable — that's fine */ }
  return false;
}

export async function offerSetupIfMissing(binary: string, ide: IdeKind): Promise<void> {
  if (isAxmeInitialized()) return;
  const root = workspaceRoot();
  if (!root) return;

  const choice = await vscode.window.showInformationMessage(
    `AXME Code is not initialised in ${basename(root)}. Run setup now?`,
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

  // Setup spawns LLM scanners (oracle / decision / safety / deploy) which
  // each call the agent SDK and need a credential. The CLI's
  // ensureAuthConfiguredForSetup() interactively prompts when TTY is
  // present, but we spawn it from VS Code with no TTY — so it silently
  // skips the prompt and the first scanner fails with an opaque exit code.
  // Run our extension-side modal first instead: it has paste-key UX,
  // dashboard links, and matches the same auth flow the auditor uses.
  // Skip if a credential is already saved (which is why your re-install
  // appeared to "find" a key — auth.yaml persists across uninstalls).
  const existingMode = await detectCurrentMode(binary).catch(() => undefined);
  if (!existingMode) {
    const picked = await ensureAuditorAuth(binary);
    if (!picked || picked === "disabled") {
      void vscode.window.showWarningMessage(
        "AXME Code: setup cancelled — needs an LLM credential to scan the project. " +
          "Either paste a key when prompted, or use the cooperative \"Ask agent to setup\" path instead.",
      );
      return;
    }
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
        const child = spawnBinary(binary, args, {
          cwd: root,
          // AXME_SETUP_FROM_EXTENSION tells the CLI's cursor-writers to skip
          // project-level .cursor/{mcp,hooks}.json: the extension registers
          // the MCP server via the cursor API on every activation and owns
          // user-level hooks. The project files setup used to write embedded
          // this version-numbered extension dir's absolute paths — stale
          // after every extension update — and double-fired hooks.
          env: { ...process.env, AXME_TELEMETRY_DISABLED: "1", AXME_SETUP_FROM_EXTENSION: "1" },
        });
        child.stdout!.on("data", (chunk) => log(`setup stdout: ${String(chunk).trimEnd()}`));
        child.stderr!.on("data", (chunk) => log(`setup stderr: ${String(chunk).trimEnd()}`));
        child.on("error", (err) => {
          logError("setup spawn", err);
          resolve(1);
        });
        child.on("exit", (code) => resolve(code ?? 1));
      });

      if (exitCode === 0) {
        progress.report({ message: "done" });
        // Flip the walkthrough completion key — onContext listeners in the
        // Welcome page check off the "Set up the workspace" step the moment
        // this fires.
        void vscode.commands.executeCommand("setContext", "axme.workspaceInitialized", true);
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
