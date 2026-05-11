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

export async function registerMcpServer(binary: string): Promise<vscode.Disposable> {
  const cursor = getCursorMcpApi();
  if (!cursor?.registerServer) {
    throw new Error(
      "Cursor MCP extension API not available. Update Cursor to 0.42+ " +
        "or check that you're not running the extension in a VS Code fork " +
        "that lacks vscode.cursor.mcp.",
    );
  }
  cursor.registerServer({
    name: "axme",
    server: { command: binary, args: ["serve"], env: {} },
  });
  log(`MCP: registered 'axme' (binary=${binary})`);
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
