/**
 * Detect whether the extension is running in Cursor (vs vanilla VS Code or
 * any other VS Code fork).
 *
 * Cursor exposes a proprietary namespace `vscode.cursor` that's the primary
 * signal. As fallback we check `vscode.env.appName` for the literal string.
 *
 * Why Cursor-only for v0.0.1: full axme-code functionality (MCP tools,
 * safety hooks, auto-audit at chat end) requires three Cursor-specific
 * APIs — `cursor.mcp.registerServer`, `~/.cursor/hooks.json`, and a
 * sessionEnd lifecycle event for the auditor. VS Code 1.119 (the latest
 * at extension v0.0.1 ship time) has no equivalent for hooks or chat-end
 * lifecycle, so shipping there would deliver MCP tools only and confuse
 * users. We document the Cursor requirement upfront in the README and
 * bail out cleanly when activated elsewhere.
 */

import * as vscode from "vscode";

export type IdeKind = "cursor" | "vscode";

export function detectIde(): IdeKind {
  const v = vscode as unknown as { cursor?: unknown };
  if (v.cursor !== undefined) return "cursor";

  const appName = (vscode.env.appName ?? "").toLowerCase();
  if (appName.includes("cursor")) return "cursor";

  return "vscode";
}

export function isCursor(): boolean {
  return detectIde() === "cursor";
}
