/**
 * Lazy extraction of the bundled Node runtime tarball on Windows.
 *
 * The win32-x64 .vsix ships node.exe expanded plus a tarball
 * (`extension/bin/node-runtime/npm-bundle.tar.gz`) containing the
 * npm CLI scripts (npm.cmd, npx.cmd) and the full node_modules/
 * tree (npm, corepack, etc) — roughly 30 MB unpacked, thousands of
 * small .js files.
 *
 * Why a tarball: Cursor's installer extracts each .vsix file via
 * CreateFileW, which on Windows hits filter drivers (Windows
 * Defender, OneDrive sync agent, third-party AV) on every single
 * file. With 3000+ npm files this drove install time from ~30 s
 * to 2-3 min on real users' machines. Bundling them as a tarball
 * lets Cursor write a single ~10 MB file, then we extract on
 * demand via Windows' built-in tar.exe — which doesn't go through
 * the same per-file filter-driver path and finishes in ~5-10 s.
 *
 * Extraction is one-time per install: we drop a sentinel file once
 * done, and skip on subsequent calls. POSIX platforms ship the
 * shebang-shim binary natively and don't need bundled Node at all,
 * so this entire module is a no-op there.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { log, logError } from "./log.js";

const execFileAsync = promisify(execFile);

let _extensionPath: string | undefined;

/**
 * Stash the extension's install path so ensureBundledNpmExtracted()
 * can find the bundled runtime tarball without callers having to
 * pass vscode.ExtensionContext through every layer. Called once at
 * activation from extension.ts (mirrors the setBundledNode pattern
 * in spawn-binary.ts).
 */
export function setExtensionPath(p: string): void {
  _extensionPath = p;
}

/**
 * Ensure the bundled npm runtime is extracted next to the bundled
 * node.exe. Idempotent — returns immediately if already extracted
 * (or if we're on a non-Windows platform where no bundle ships).
 *
 * Throws an error if extraction fails. Callers should surface this
 * to the user via a toast — without npm extracted, search-mode
 * cannot fetch the transformers runtime.
 *
 * Async (Promise-based) so the extension host event loop stays
 * responsive during extraction — earlier versions used execFileSync
 * which blocked all UI (button clicks, sidebar re-renders) for the
 * 5-10 s of tar extraction. Users saw "frozen" buttons. Callers can
 * `await` this from within a `withProgress` block to show a
 * meaningful "Extracting bundled runtime..." indicator.
 *
 * @returns true if extraction ran this call, false if it was
 *          already extracted (or non-Windows).
 */
export async function ensureBundledNpmExtracted(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  if (!_extensionPath) {
    throw new Error(
      "AXME Code: setExtensionPath() was not called before ensureBundledNpmExtracted(). " +
        "This is an internal extension wiring bug; please report.",
    );
  }

  const nodeRuntimeDir = join(_extensionPath, "bin", "node-runtime");
  // Sentinel: an arbitrary file that's only present after the tarball
  // is extracted. npm-cli.js is the file search-install.ts itself
  // probes for, so reusing it keeps the contract consistent.
  const sentinel = join(nodeRuntimeDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(sentinel)) {
    return false;
  }

  const tarball = join(nodeRuntimeDir, "npm-bundle.tar.gz");
  if (!existsSync(tarball)) {
    throw new Error(
      `AXME Code: bundled npm runtime tarball missing at ${tarball}. ` +
        `The .vsix install appears incomplete — please uninstall and reinstall ` +
        `the extension.`,
    );
  }

  const start = Date.now();
  log(`Bundled runtime: extracting ${tarball} ...`);

  try {
    // Use Windows' built-in tar.exe (ships with Windows 10 1803+, 2018).
    // bsdtar under the hood. Handles .tar.gz transparently via -z.
    // `-C` sets the destination dir. Async wrapper so the extension
    // host event loop stays responsive.
    await execFileAsync("tar", ["-xzf", tarball, "-C", nodeRuntimeDir], {
      windowsHide: true,
    });
  } catch (err) {
    logError("Bundled runtime extraction failed", err);
    throw new Error(
      `AXME Code: failed to extract bundled npm runtime. Windows tar.exe ` +
        `(built-in since Win10 1803) is required for this step. ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  if (!existsSync(sentinel)) {
    throw new Error(
      `AXME Code: tarball extraction completed but npm-cli.js still missing ` +
        `at ${sentinel} — the bundled tarball may be corrupt.`,
    );
  }

  const elapsedMs = Date.now() - start;
  log(`Bundled runtime: extracted in ${elapsedMs}ms`);
  return true;
}
