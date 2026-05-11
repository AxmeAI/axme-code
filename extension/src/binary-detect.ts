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
