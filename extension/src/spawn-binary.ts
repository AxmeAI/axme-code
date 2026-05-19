/**
 * Cross-platform spawn of the bundled axme-code binary.
 *
 * The bundled binary in extension/bin/ is a shebang shim — text starting
 * with `#!/usr/bin/env node` followed by a CJS payload. POSIX systems
 * honor the shebang and run the file directly. Windows ignores shebangs
 * and rejects the file with ENOENT / UNKNOWN when treated as an
 * executable, regardless of the .exe / .cjs file-extension we ship.
 *
 * The Windows strategy: ship an actual Node.exe inside the .vsix
 * (extension/bin/node-windows-x64.exe, copied from the official
 * node-v20.x.x-win-x64.zip during CI). Invoke that bundled Node
 * directly with the bundled JS payload as argv[0]. No system Node
 * dependency, no shebang gymnastics, no ELECTRON_RUN_AS_NODE
 * pass-through quirks — works regardless of whether the user has Node
 * installed.
 *
 * The bundled-node path is set once on extension activation via
 * `setBundledNode()` (called from extension.ts after findBundledNode()
 * resolves it from context.extensionPath). `spawnBinary` doesn't
 * receive vscode context, so caching it module-level is the cleanest
 * way to give every spawn site access without threading context
 * through every caller.
 *
 * Every spawn of the bundled binary in the extension should go through
 * this helper. A direct `spawn(binary, args)` will work on Linux + macOS
 * but silently break on Windows.
 */

import { spawn, ChildProcess, ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";

let _bundledNode: string | undefined;

/**
 * Cache the bundled Node.exe path discovered by findBundledNode() at
 * activation time. Called once from extension.ts. No-op on non-Windows
 * platforms where bundled Node isn't shipped or needed.
 */
export function setBundledNode(path: string | undefined): void {
  _bundledNode = path;
}

/** For diagnostics / tests. */
export function getBundledNode(): string | undefined {
  return _bundledNode;
}

/**
 * Cross-platform spawn of the bundled binary. Two overloads mirror
 * Node's own `spawn` typing so callers keep the non-null stdio
 * narrowing they had with the original spawn(binary, args, ...) call.
 */
export function spawnBinary(
  binary: string,
  args: string[],
): ChildProcessWithoutNullStreams;
export function spawnBinary(
  binary: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess;
export function spawnBinary(
  binary: string,
  args: string[],
  options?: SpawnOptions,
): ChildProcess {
  const opts = options ?? {};
  if (process.platform === "win32") {
    if (!_bundledNode) {
      throw new Error(
        "AXME Code: bundled Node.exe not found. " +
          "This usually means extension/bin/node-windows-x64.exe is missing " +
          "from the .vsix you installed. Try reinstalling the extension; " +
          "if the problem persists open an issue at https://github.com/AxmeAI/axme-code/issues.",
      );
    }
    return spawn(_bundledNode, [binary, ...args], opts);
  }
  return spawn(binary, args, opts);
}
