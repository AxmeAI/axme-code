/**
 * Locate the axme-code binary on the user's machine.
 *
 * Resolution order:
 *   1. `axme.binaryPath` setting (explicit user override).
 *   2. `AXME_CLAUDE_EXECUTABLE` env var (undocumented CI override).
 *   3. Bundled binary inside the .vsix at <extensionPath>/bin/axme-code
 *      (or axme-code.exe on win32-x64). This is the post-install primary
 *      path for v0.0.1 — CI ships six platform-specific .vsix files, each
 *      with the matching binary in bin/, so this resolves unambiguously.
 *   4. PATH lookup via `which` / `where.exe`.
 *   5. Standard install locations: ~/.local/bin/axme-code,
 *      /usr/local/bin/axme-code, /opt/homebrew/bin/axme-code, /usr/bin/.
 *
 * The bundled path (3) is preferred over PATH (4) so users don't
 * accidentally run a stale system install when the extension is up to
 * date.
 *
 * Returns absolute path or undefined. Caller surfaces a user-facing
 * error when undefined.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

async function whichLookup(name: string): Promise<string | undefined> {
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await execFileAsync(cmd, [name], { timeout: 3000 });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  } catch {
    /* not found via PATH */
  }
  return undefined;
}

function bundledBinaryPath(context: vscode.ExtensionContext): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return join(context.extensionPath, "bin", `axme-code${ext}`);
}

/**
 * Locate the bundled Node.exe that ships inside the .vsix on Windows.
 *
 * Why we need this: extension/bin/axme-code.exe is a shebang-shim text
 * file (`#!/usr/bin/env node` + CJS payload). POSIX systems execute it
 * via the shebang. Windows ignores shebangs entirely — it can't execute
 * the file as a PE binary. Previous fixes tried using Cursor's own
 * Electron binary as a Node interpreter via ELECTRON_RUN_AS_NODE=1, but
 * Cursor's `registerServer({env})` API is undocumented and the env var
 * doesn't reliably reach the spawned process. The current strategy is
 * the simplest one that works: ship an actual Node.exe inside the .vsix
 * and invoke it directly.
 *
 * The CI matrix downloads node-v20.x.x-win-x64.zip during build and
 * unpacks it into extension/bin/node-runtime/ (containing node.exe +
 * npm.cmd + node_modules/npm/ so search-mode can run `npm install`
 * without a system Node). This function returns the absolute path of
 * node.exe at runtime so spawn-binary / mcp-register / hooks-install
 * can use it. findBundledNpm() returns the sibling npm.cmd path for
 * search-install.ts to invoke.
 *
 * Returns undefined on non-Windows platforms (Linux/macOS execute the
 * shebang shim natively, no bundled Node needed there) and when the
 * file is missing (broken install — caller surfaces an actionable
 * error to the user).
 */
export function findBundledNode(context: vscode.ExtensionContext): string | undefined {
  if (process.platform !== "win32") return undefined;
  const p = join(context.extensionPath, "bin", "node-runtime", "node.exe");
  return existsSync(p) ? p : undefined;
}

/**
 * Locate the bundled npm.cmd that ships alongside the bundled Node.
 * Used by search-mode runtime install (`npm install @huggingface/
 * transformers`). When the bundled Node is present, npm.cmd is its
 * sibling. Returns undefined elsewhere.
 *
 * Note: search-install.ts runs inside the MCP-server child process
 * (the bundled axme-code binary), not inside the extension host, so
 * this function isn't called from search-install.ts directly. Instead,
 * search-install.ts derives the npm.cmd path from process.execPath
 * (the absolute path of node.exe under which the binary is running).
 * This helper is provided for diagnostics / future extension-side
 * features that want to check whether npm is available.
 */
export function findBundledNpm(context: vscode.ExtensionContext): string | undefined {
  if (process.platform !== "win32") return undefined;
  const p = join(context.extensionPath, "bin", "node-runtime", "npm.cmd");
  return existsSync(p) ? p : undefined;
}

function standardInstallLocations(): string[] {
  const home = homedir();
  const ext = process.platform === "win32" ? ".cmd" : "";
  return [
    join(home, ".local", "bin", `axme-code${ext}`),
    "/usr/local/bin/axme-code",
    "/opt/homebrew/bin/axme-code",
    "/usr/bin/axme-code",
  ];
}

export async function findAxmeBinary(context: vscode.ExtensionContext): Promise<string | undefined> {
  // 1. Settings override
  const cfg = vscode.workspace.getConfiguration("axme");
  const explicit = cfg.get<string>("binaryPath", "").trim();
  if (explicit && existsSync(explicit)) return explicit;

  // 2. Env override
  const envOverride = process.env.AXME_CLAUDE_EXECUTABLE;
  if (envOverride && existsSync(envOverride)) return envOverride;

  // 3. Bundled binary inside the .vsix
  const bundled = bundledBinaryPath(context);
  if (existsSync(bundled)) return bundled;

  // 4. PATH lookup
  const fromPath = await whichLookup("axme-code");
  if (fromPath) return fromPath;

  // 5. Standard install locations
  for (const candidate of standardInstallLocations()) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}
