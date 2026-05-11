/**
 * AXME Code output channel logger. Lazy-creates a single VS Code
 * `OutputChannel` and prepends an ISO timestamp to each line. Use for
 * activation diagnostics, MCP register lifecycle, hook install results.
 */

import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("AXME Code");
  return channel;
}

export function log(message: string): void {
  const ts = new Date().toISOString();
  getChannel().appendLine(`[${ts}] ${message}`);
}

export function logError(message: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log(`ERROR ${message}: ${detail}`);
  if (err instanceof Error && err.stack) getChannel().appendLine(err.stack);
}

export function show(): void {
  getChannel().show();
}

export function dispose(): void {
  channel?.dispose();
  channel = undefined;
}
