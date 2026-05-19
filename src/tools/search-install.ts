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
 * Resolve how to invoke npm for installing the transformers runtime.
 *
 * Windows: spawning a .cmd/.bat (npm.cmd) with shell:false throws EINVAL
 * after the Node CVE-2024-27980 fix (Node >= 18.20.2/20.12.2/21.7.3) —
 * an absolute path does NOT make it safe. So we invoke npm's CLI JS
 * directly with the bundled node.exe (a real executable, safe with
 * shell:false, and Node quotes argv correctly for paths with spaces).
 * Only if npm-cli.js can't be found do we fall back to npm.cmd, which
 * then must go through a shell.
 *
 * POSIX: `npm` on PATH (no .cmd wrapper, spawns fine without a shell).
 *
 * Returns { cmd, args, useShell }. args is prepended to the npm argv
 * (the node.exe + npm-cli.js form). useShell is true only for the
 * .cmd fallbacks, where the caller also shell-quotes arguments.
 */
function resolveNpm(): { cmd: string; args: string[]; useShell: boolean } {
  if (process.platform !== "win32") {
    return { cmd: "npm", args: [], useShell: false };
  }
  // process.execPath = the node.exe running us (the extension's bundled
  // bin/node-runtime/node.exe, or the user's global node when standalone).
  const nodeDir = dirname(process.execPath);
  // Standard Node distributions ship npm's CLI here, next to node.exe.
  const npmCli = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(npmCli)) {
    return { cmd: process.execPath, args: [npmCli], useShell: false };
  }
  const cmdCandidate = join(nodeDir, "npm.cmd");
  if (existsSync(cmdCandidate)) {
    return { cmd: cmdCandidate, args: [], useShell: true };
  }
  // Standalone, no bundled node: npm.cmd via PATH (cmd.exe + PATHEXT).
  return { cmd: "npm.cmd", args: [], useShell: true };
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
  const npmArgs = [
    ...npm.args,
    "install",
    "--prefix", dir,
    "--no-audit",
    "--no-fund",
    // sharp is listed as an optionalDependency of @huggingface/
    // transformers, but transformers' code unconditionally requires
    // it at module load time (image utils are imported even when the
    // caller only uses text pipelines). An earlier round of fixes
    // tried `--omit=optional` to skip sharp's troublesome postinstall
    // — that worked at install time, but the runtime then failed with
    // `Could not load the "sharp" module using the win32-x64 runtime`
    // when our embedder tried to import transformers (verified on a
    // clean Windows VM 2026-05-19). PATH augmentation below is the
    // real fix — sharp's postinstall `cmd /c node install/check.js`
    // finds `node` via PATH, downloads its prebuilt binary, and the
    // runtime load succeeds.
    `@huggingface/transformers@${TRANSFORMERS_VERSION}`,
  ];
  // shell:true (the .cmd fallback) does NOT quote argv — Node joins on
  // spaces and hands the string to cmd.exe — so quote whitespace args
  // ourselves (the --prefix path may sit under a profile dir with
  // spaces). shell:false needs no quoting: Node escapes for CreateProcess.
  const spawnArgs = npm.useShell
    ? npmArgs.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    : npmArgs;
  // Augment PATH so any subprocess npm spawns (preinstall / postinstall
  // scripts of dependencies) can find `node` and `npm` — they shell
  // out via cmd.exe which inherits PATH. Without this, even with
  // --omit=optional in place a future dependency with a postinstall
  // script would fail the same way sharp did. Belt-and-braces.
  const nodeDir = dirname(process.execPath);
  const sep = process.platform === "win32" ? ";" : ":";
  const augmentedPath = `${nodeDir}${sep}${process.env.PATH ?? ""}`;
  const result = spawnSync(npm.cmd, spawnArgs, {
    stdio: ["ignore", "inherit", "inherit"],
    shell: npm.useShell,
    env: { ...process.env, PATH: augmentedPath },
  });

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
