/**
 * Cross-platform spawn of the bundled axme-code binary.
 *
 * The bundled binary in extension/bin/ is a shebang shim — text starting
 * with `#!/usr/bin/env node` followed by a CJS payload. POSIX systems
 * honor the shebang and run the file directly. Windows ignores shebangs
 * and rejects the file with ENOENT / UNKNOWN when treated as an
 * executable, regardless of the .exe / .cjs file-extension we ship.
 *
 * The fix on Windows: invoke via Cursor's own Electron binary
 * (`process.execPath`) with the env var `ELECTRON_RUN_AS_NODE=1`. That
 * makes Cursor.exe behave as a plain Node interpreter and execute the
 * JS payload. We DO NOT rely on the user having `node.exe` on PATH —
 * most Windows users of a chat-agent IDE will not.
 *
 * This is the same pattern VS Code itself uses internally for spawning
 * Node subprocesses (e.g. language servers via vscode-languageclient).
 * Documented at https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node
 *
 * Every spawn of the bundled binary in the extension should go through
 * this helper. A direct `spawn(binary, args)` will work on Linux + macOS
 * but silently break on Windows.
 */

import { spawn, ChildProcess, ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";

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
    return spawn(process.execPath, [binary, ...args], {
      ...opts,
      env: { ...process.env, ...(opts.env as NodeJS.ProcessEnv | undefined), ELECTRON_RUN_AS_NODE: "1" },
    });
  }
  return spawn(binary, args, opts);
}
