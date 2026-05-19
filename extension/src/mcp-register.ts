/**
 * Register the AXME MCP server with Cursor at activation time.
 *
 * Cursor exposes `(vscode as any).cursor.mcp.registerServer(config)` —
 * an undocumented-but-stable extension API (verified empirically against
 * the production extension `serkan-ozal/browser-devtools-mcp-vscode`).
 * Calling this bypasses Cursor's project-level `.cursor/mcp.json` Enable
 * gate because the trust boundary moves to "user installed this
 * extension".
 *
 * Returns a Disposable the caller (extension.ts deactivate) must dispose
 * so the server unregisters cleanly when the extension is disabled or
 * uninstalled.
 */

import * as vscode from "vscode";
import { log, logError } from "./log.js";
import { getBundledNode } from "./spawn-binary.js";

interface CursorMcpApi {
  registerServer(config: {
    name: string;
    server:
      | { command: string; args: string[]; env?: Record<string, string> }
      | { url: string; headers?: Record<string, string> };
  }): void;
  unregisterServer(name: string): void;
}

function getCursorMcpApi(): CursorMcpApi | undefined {
  const v = vscode as unknown as { cursor?: { mcp?: CursorMcpApi } };
  return v.cursor?.mcp;
}

export async function registerMcpServer(
  binary: string,
  workspaceRoot: string | undefined,
): Promise<vscode.Disposable> {
  const cursor = getCursorMcpApi();
  if (!cursor?.registerServer) {
    throw new Error(
      "Cursor MCP extension API not available. Update Cursor to 0.42+ " +
        "or check that you're not running the extension in a VS Code fork " +
        "that lacks vscode.cursor.mcp.",
    );
  }
  // Pass --workspace explicitly. Cursor spawns the MCP server from the
  // user's home dir regardless of which workspace is open, so the server's
  // process.cwd() is useless for resolving `.axme-code/`. Without this
  // flag, axme_context defaults project_path to /home/$USER and reports
  // "project not initialised" even after a successful setup in the real
  // workspace. The server's resolveServerRoot() reads this flag.
  const serveArgs = workspaceRoot ? ["serve", "--workspace", workspaceRoot] : ["serve"];

  // Cross-platform spawn: the bundled binary in extension/bin/ is a
  // shebang-shim text file (`#!/usr/bin/env node` + CJS payload, no
  // extension on POSIX, .exe on Windows). POSIX honors the shebang and
  // runs the file via node. Windows ignores shebangs and refuses to
  // execute the file as a PE binary → Cursor's MCP runner does
  // `spawn(command, args)` directly and gets ENOENT, which surfaces in
  // the chat as "MCP server does not exist … No MCP servers available."
  //
  // Earlier attempts:
  //   1. spawn("node", ...) — required user to have Node on PATH, which
  //      most Windows chat-IDE users don't.
  //   2. spawn(process.execPath, ..., env: { ELECTRON_RUN_AS_NODE: "1" })
  //      — relied on Cursor's MCP runner passing the env field through
  //      to spawn(). Cursor's registerServer() API is undocumented and
  //      the env pass-through is NOT reliable in practice. User-reported
  //      MCP still failed to boot on Windows even with this fix.
  //
  // Current strategy: ship an actual Node.exe inside the .vsix and tell
  // Cursor to spawn THAT as the MCP server command, with the bundled JS
  // payload as argv[0]. This is a plain process spawn — no env tricks,
  // no Electron-as-Node, no system Node dependency. The bundled Node
  // path is resolved at activation time via findBundledNode() and
  // cached in spawn-binary.ts.
  const isWindows = process.platform === "win32";
  let command: string;
  let args: string[];
  if (isWindows) {
    const bundledNode = getBundledNode();
    if (!bundledNode) {
      throw new Error(
        "AXME Code: bundled Node.exe not found at extension/bin/node-windows-x64.exe. " +
          "MCP server cannot start. This usually means the .vsix is incomplete — please reinstall.",
      );
    }
    command = bundledNode;
    args = [binary, ...serveArgs];
  } else {
    command = binary;
    args = serveArgs;
  }
  cursor.registerServer({
    name: "axme",
    server: { command, args, env: {} },
  });
  log(`MCP: registered 'axme' (command=${command}, binary=${binary}, workspace=${workspaceRoot ?? "(none)"})`);
  // Cursor needs ~3s to process the registration before tools become
  // available to the chat agent. Verified empirically against the
  // browser-devtools-mcp reference implementation.
  await new Promise((r) => setTimeout(r, 3000));
  return new vscode.Disposable(() => {
    try {
      cursor.unregisterServer("axme");
      log("MCP: unregistered 'axme'");
    } catch (err) {
      logError("MCP unregister", err);
    }
  });
}
