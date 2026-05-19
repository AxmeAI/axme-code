/**
 * CLI helpers for the search-mode opt-in flow:
 *
 *   axme-code config set context.mode search
 *     1. install @huggingface/transformers into ~/.local/share/axme-code/runtime/
 *     2. build the initial embeddings index from every memory + decision on disk
 *     3. on either failure → caller rolls config back to "full" (B-005 design)
 *
 *   axme-code reindex
 *     full re-embed of every memory + decision into embeddings.json
 *
 * Errors are returned as structured `{ ok: false, error }` so callers can
 * decide how to surface them (CLI prints, MCP returns text, tests assert).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { listMemories } from "../storage/memory.js";
import { listDecisions } from "../storage/decisions.js";
import {
  loadEmbedder,
  isRuntimeInstalled,
  runtimeDir,
  saveEmbeddings,
  _resetEmbedderCache,
  type EmbedRecord,
} from "../storage/embeddings.js";

const TRANSFORMERS_VERSION = "^4.0.1";

export interface InstallResult {
  ok: boolean;
  indexed?: number;
  error?: string;
}

/**
 * Run `npm install --prefix <runtimeDir> @huggingface/transformers@<ver>`.
 * Synchronous; inherits stderr so the user sees real-time progress.
 *
 * Why npm and not a vendored tarball: transformers ships ONNX runtime that
 * needs platform-specific binaries; npm picks the right one for the user's
 * platform automatically. ~30s on a fresh runtime, no-op if already there.
 */
/**
 * Resolve the npm executable to use for installing the transformers
 * runtime. On Windows we prefer the npm.cmd bundled inside the .vsix
 * (sibling of the Node.exe currently running us) so the user doesn't
 * need a system Node/npm install. Falls back to `npm.cmd` on PATH
 * if no bundled npm is found (e.g. axme-code installed standalone via
 * the curl one-liner, not via the VS Code extension).
 *
 * On POSIX, just `npm` — Linux/macOS users running standalone have
 * Node + npm on PATH; users running through the extension's shebang-
 * shim are also on Node, which means they have npm.
 *
 * Returns { cmd, useShell } — useShell controls whether spawn() needs
 * shell:true. Direct .exe / absolute-path invocations are safe without
 * a shell; bare-name lookups (`npm`, `npm.cmd`) need the shell to do
 * PATH resolution on Windows.
 */
function resolveNpm(): { cmd: string; useShell: boolean } {
  if (process.platform !== "win32") {
    return { cmd: "npm", useShell: false };
  }
  // process.execPath inside this child = the Node.exe that was spawned
  // by the extension's bundled-Node path (extension/bin/node-runtime/
  // node.exe). npm.cmd lives in the same directory.
  const candidate = join(dirname(process.execPath), "npm.cmd");
  if (existsSync(candidate)) {
    return { cmd: candidate, useShell: false };
  }
  // Standalone install path — user is running axme-code from a global
  // Node, npm is on PATH. shell:true so cmd.exe resolves npm.cmd via PATHEXT.
  return { cmd: "npm.cmd", useShell: true };
}

function installTransformers(): { ok: boolean; error?: string } {
  const dir = runtimeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // npm requires a package.json in the prefix dir to install into it
  // without polluting the parent project. Create a minimal one if missing.
  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({ name: "axme-code-runtime", private: true, version: "0.0.0" }, null, 2) + "\n");
  }

  process.stderr.write(`AXME: installing semantic-search runtime into ${dir} (one-time, ~100 MB)...\n`);
  const npm = resolveNpm();
  const result = spawnSync(npm.cmd, [
    "install",
    "--prefix", dir,
    "--no-audit",
    "--no-fund",
    `@huggingface/transformers@${TRANSFORMERS_VERSION}`,
  ], { stdio: ["ignore", "inherit", "inherit"], shell: npm.useShell });

  if (result.error) return { ok: false, error: `npm spawn failed (${npm.cmd}): ${result.error.message}` };
  if (result.status !== 0) return { ok: false, error: `npm install exited with code ${result.status} (npm=${npm.cmd})` };

  // Reset the embedder cache so the next loadEmbedder() picks up the freshly
  // installed runtime instead of returning the previous null.
  _resetEmbedderCache();
  return { ok: true };
}

/**
 * The full-context entry text we feed into the embedder for each record.
 * Matches what `embedKbEntry` produces for incremental saves so search
 * results are consistent across initial reindex and live updates.
 */
function entryText(title: string, body: string): string {
  return `${title}. ${body}`;
}

/**
 * Read every memory and decision on disk, embed each, write a fresh
 * embeddings.json. Existing index is replaced entirely (no merge).
 */
export async function reindexAll(projectPath: string): Promise<InstallResult> {
  if (!isRuntimeInstalled()) {
    return {
      ok: false,
      error: "Embeddings runtime not installed. Run `axme-code config set context.mode search` first.",
    };
  }
  const embedder = await loadEmbedder();
  if (!embedder) {
    return { ok: false, error: "Failed to load embedder (runtime present but module did not load)." };
  }

  const memories = listMemories(projectPath);
  const decisions = listDecisions(projectPath);
  const total = memories.length + decisions.length;
  if (total === 0) {
    await saveEmbeddings(projectPath, []);
    return { ok: true, indexed: 0 };
  }

  const records: EmbedRecord[] = [];
  let processed = 0;
  const tickEvery = Math.max(1, Math.floor(total / 20));
  const now = Date.now();

  for (const m of memories) {
    const vec = await embedder.embed(entryText(m.title, m.description));
    records.push({
      slug: m.slug,
      type: "memory",
      title: m.title,
      description: m.description,
      mtime: now,
      embedding: Array.from(vec),
    });
    processed++;
    if (processed % tickEvery === 0) {
      process.stderr.write(`  embedded ${processed}/${total}\r`);
    }
  }

  for (const d of decisions) {
    const vec = await embedder.embed(entryText(d.title, d.decision));
    records.push({
      slug: d.id,
      type: "decision",
      title: d.title,
      description: d.decision,
      mtime: now,
      embedding: Array.from(vec),
    });
    processed++;
    if (processed % tickEvery === 0) {
      process.stderr.write(`  embedded ${processed}/${total}\r`);
    }
  }
  process.stderr.write(`  embedded ${processed}/${total}\n`);

  await saveEmbeddings(projectPath, records);
  return { ok: true, indexed: records.length };
}

/**
 * Atomic "switch to search mode" flow: install runtime if missing, then
 * reindex. Caller (CLI config set handler) is responsible for writing the
 * config.yaml mode field — we don't touch it here so the rollback path
 * stays explicit and visible at the call site.
 */
export async function runConfigSetSearch(projectPath: string): Promise<InstallResult> {
  if (!isRuntimeInstalled()) {
    const installed = installTransformers();
    if (!installed.ok) return { ok: false, error: installed.error };
  }
  return reindexAll(projectPath);
}
