/**
 * Cross-platform spawn of the bundled axme-code binary.
 *
 * The bundled binary in extension/bin/ is a shebang shim — text starting
 * with `#!/usr/bin/env node` followed by a CJS payload. POSIX systems
 * honor the shebang and run the file directly. Windows ignores shebangs
 * and rejects the file with ENOENT / UNKNOWN when treated as an
 * executable, regardless of the .exe / .cjs file-extension we ship.
 *
 * The fix on Windows is to invoke via `node <binary>` so Node executes
 * the JS payload directly. Cursor users on Windows nearly always have
 * Node installed for dev work; we rely on `node` being on PATH (cmd.exe
 * /c looks up commands the same way an interactive shell does).
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
    return spawn("node", [binary, ...args], opts);
  }
  return spawn(binary, args, opts);
}
