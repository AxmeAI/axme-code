/**
 * Semantic search mode UX for the Cursor extension.
 *
 * Mirrors the Claude Code CLI flow:
 *   - default `full` mode loads every memory + decision body at session
 *     start (compact, works without any extra runtime)
 *   - opt-in `search` mode loads only the catalog (slug + title +
 *     1-line description) and exposes axme_search_kb so the agent
 *     fetches bodies on demand. Requires the @huggingface/transformers
 *     runtime + an embeddings index — both installed atomically by
 *     `axme-code config set context.mode search`.
 *
 * State lives in `.axme-code/config.yaml`. The VS Code setting
 * `axme.contextMode` previously claimed to control it but never did
 * (CORE reads the workspace yaml, not VS Code globals). This module is
 * the single source of truth from the extension side.
 */

import * as vscode from "vscode";
import { spawnBinary } from "./spawn-binary.js";
import { ensureBundledNpmExtracted } from "./bundled-runtime.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log, logError, show as showOutput } from "./log.js";

export type ContextMode = "full" | "search";

/**
 * Read context.mode from `.axme-code/config.yaml`. Falls back to "full"
 * when missing — matches CORE's readConfig default.
 *
 * The YAML schema is nested:
 *
 *   context:
 *     mode: full | search
 *
 * Earlier drafts used a flat `^contextMode:` regex (camelCase) which
 * never matched anything in the actual file — sidebar always read
 * "full" even after the CLI flipped the config to "search", and the
 * Enable/Disable toggle UI showed wrong state. The fix is a multiline
 * regex anchored on the `context:` header then the indented `mode:`
 * line. We don't pull a full YAML parser because the schema is stable
 * and the extension bundle stays smaller without it.
 */
export function readContextMode(workspaceRoot: string): ContextMode {
  const cfg = join(workspaceRoot, ".axme-code", "config.yaml");
  if (!existsSync(cfg)) return "full";
  try {
    const txt = readFileSync(cfg, "utf-8");
    const m = /^context\s*:\s*\r?\n\s+mode\s*:\s*(\w+)/m.exec(txt);
    if (m && (m[1] === "full" || m[1] === "search")) return m[1];
  } catch { /* swallow */ }
  return "full";
}

/**
 * True when the transformers runtime is on disk. Cheap directory check
 * — no module load. Used to decide whether to show "install runtime"
 * or just "reindex" in the enable flow.
 */
export function runtimeInstalled(): boolean {
  return existsSync(join(homedir(), ".local", "share", "axme-code", "runtime", "node_modules", "@huggingface", "transformers"));
}

/**
 * The on-disk embeddings index size (records count), or 0 if missing.
 * Surfaced in the sidebar so the user knows what's indexed.
 */
export function indexedCount(workspaceRoot: string): number {
  const p = join(workspaceRoot, ".axme-code", "_index", "embeddings.json");
  if (!existsSync(p)) return 0;
  try {
    const obj = JSON.parse(readFileSync(p, "utf-8"));
    if (Array.isArray(obj)) return obj.length;
    if (obj && Array.isArray(obj.records)) return obj.records.length;
    return 0;
  } catch { return 0; }
}

/**
 * Run the enable flow: confirm with the user, spawn
 * `axme-code config set context.mode search`, stream stdout/stderr to
 * the output channel, surface success/failure as a toast.
 *
 * The CLI subcommand installs @huggingface/transformers into
 * ~/.local/share/axme-code/runtime/ (~770 MB on Linux including
 * onnxruntime-node prebuilts) AND builds the initial embeddings index
 * from every memory + decision on disk. Failure rolls config back to
 * `full` automatically.
 */
export async function enableSearchMode(binary: string, workspaceRoot: string): Promise<void> {
  const needsRuntime = !runtimeInstalled();
  const kbPath = join(workspaceRoot, ".axme-code");
  const kbInitialized = existsSync(kbPath);

  const sizeNote = needsRuntime
    ? " The first time will download ~770 MB of ML runtime (one-time, lives in ~/.local/share/axme-code/runtime/)."
    : "";

  // Pre-setup edge case: enabling search before .axme-code/ exists is
  // legal but produces an empty index. axme-code setup (when the user
  // runs it later) auto-reindexes on completion so the populated KB
  // lands in the index, but tell the user upfront so it's not a surprise.
  const preSetupNote = kbInitialized
    ? ""
    : "\n\nNote: this project's knowledge base hasn't been set up yet. " +
      "Semantic search will turn on with an empty index. The next time " +
      "you run AXME setup, scanned decisions / memories will be auto- " +
      "indexed; cooperative-flow saves via the agent auto-embed too. " +
      "Result either way: search works the moment KB has content.";

  const choice = await vscode.window.showWarningMessage(
    `Enable semantic search?${sizeNote}\n\n` +
      `After enabling, axme_context will load only the catalog (titles + ` +
      `1-line descriptions) at session start. The agent fetches full ` +
      `bodies on demand via axme_search_kb — saves tokens on large knowledge bases.${preSetupNote}`,
    { modal: true },
    "Enable",
    "Cancel",
  );
  if (choice !== "Enable") return;

  // Wrap BOTH the lazy-extract step (Windows only, 5-10 s) AND the
  // npm-install step (45-90 s) inside a single withProgress block so
  // the user sees feedback immediately after clicking Enable. Earlier
  // the extract ran synchronously before withProgress fired — the
  // button appeared dead for 5-10 s on Windows and the user assumed
  // it had broken. Reported @geobelsky 2026-05-19.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "AXME: enabling semantic search",
      cancellable: false,
    },
    async (progress) => {
      // Step 1 — extract bundled npm runtime tarball (Windows only).
      // POSIX: no-op. Returns immediately if already extracted.
      progress.report({ message: "Preparing bundled Node runtime..." });
      try {
        const extracted = await ensureBundledNpmExtracted();
        if (extracted) log("search-enable: bundled npm runtime extracted from tarball");
      } catch (err) {
        logError("search-enable: bundled runtime extraction failed", err);
        void vscode.window.showErrorMessage(
          `AXME: cannot enable search mode - ${(err as Error).message}`,
          "Show output",
        ).then((c) => { if (c === "Show output") showOutput(); });
        return;
      }

      // Step 2 — run the real flow: spawn the bundled binary, install
      // @huggingface/transformers via bundled npm, reindex existing
      // memories/decisions. ~45-90 s on a typical machine.
      progress.report({
        message: needsRuntime
          ? "Installing semantic-search runtime + indexing..."
          : "Reindexing knowledge base...",
      });
      await new Promise<void>((resolve) => {
        const child = spawnBinary(
          binary,
          ["config", "set", "context.mode", "search"],
          { cwd: workspaceRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout!.on("data", (c) => log(`search-enable: ${String(c).trimEnd()}`));
        child.stderr!.on("data", (c) => log(`search-enable: ${String(c).trimEnd()}`));
        child.on("error", (err) => { logError("enableSearchMode spawn", err); resolve(); });
        child.on("exit", (code) => {
          if (code === 0) {
            void vscode.window.showInformationMessage("AXME: semantic search enabled.");
            void vscode.commands.executeCommand("axme.refreshSidebar");
          } else {
            void vscode.window.showErrorMessage(
              `AXME: failed to enable semantic search (exit ${code}). See output channel.`,
            );
            showOutput();
          }
          resolve();
        });
      });
    },
  );
}

/**
 * Flip back to full mode. Doesn't delete the runtime or the embeddings
 * index — keeps them on disk so a re-enable is fast (no second 770 MB
 * download).
 */
export async function disableSearchMode(binary: string, workspaceRoot: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Switch back to full context mode? The transformers runtime and the embeddings index stay on disk so you can re-enable instantly.",
    { modal: true },
    "Switch",
    "Cancel",
  );
  if (choice !== "Switch") return;

  const child = spawnBinary(
    binary,
    ["config", "set", "context.mode", "full"],
    { cwd: workspaceRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout!.on("data", (c) => (out += c.toString()));
  child.stderr!.on("data", (c) => (out += c.toString()));
  const code: number = await new Promise((res) => {
    child.on("exit", (c) => res(c ?? 1));
    child.on("error", () => res(1));
  });
  if (code === 0) {
    void vscode.window.showInformationMessage("AXME: switched to full context mode.");
    void vscode.commands.executeCommand("axme.refreshSidebar");
  } else {
    log(`search-disable: ${out.trim()}`);
    void vscode.window.showErrorMessage(`AXME: failed to switch (exit ${code}). See output channel.`);
    showOutput();
  }
}
