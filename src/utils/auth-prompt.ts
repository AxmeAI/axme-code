/**
 * Interactive and non-interactive helpers for selecting the auth mode used
 * by Claude Code subprocesses.
 *
 * Split from auth-config.ts so that config.ts stays dependency-free
 * (no readline, no stdio) and can be imported by scanner/auditor code paths
 * that must never block or prompt.
 */

import { createInterface } from "node:readline";
import type { AuthMode } from "../types.js";
import type { AuthOptions } from "./auth-detect.js";

export function formatDetectionBlock(options: AuthOptions): string {
  const lines: string[] = [];
  lines.push("Detected on this machine:");
  if (options.apiKey.present) {
    lines.push(`  [1] Anthropic API key: ${options.apiKey.masked} (ANTHROPIC_API_KEY)`);
  } else {
    lines.push("  [1] Anthropic API key — not set");
  }
  if (options.subscription.present) {
    const detail = options.subscription.details ? ` (${options.subscription.details})` : "";
    lines.push(`  [2] Claude Code subscription${detail}`);
  } else if (options.subscription.binaryFound) {
    lines.push("  [2] Claude Code subscription — binary found but no saved login");
    lines.push("      (run `claude` then `/login` to authenticate)");
  } else {
    lines.push("  [2] Claude Code subscription — claude binary not found on PATH");
  }
  if (options.cursorSdk?.present) {
    const detail = options.cursorSdk.details ? ` (${options.cursorSdk.details})` : "";
    lines.push(`  [3] Cursor SDK API key: ${options.cursorSdk.masked}${detail}`);
  } else {
    lines.push("  [3] Cursor SDK API key — not set (generate at cursor.com → Integrations)");
  }
  return lines.join("\n");
}

function defaultChoice(options: AuthOptions): AuthMode {
  // Single-credential machines: pick the only mode that actually works.
  const haveSub = options.subscription.present;
  const haveKey = options.apiKey.present;
  const haveCursor = options.cursorSdk?.present === true;
  const count = (haveSub ? 1 : 0) + (haveKey ? 1 : 0) + (haveCursor ? 1 : 0);
  if (count === 1) {
    if (haveSub) return "subscription";
    if (haveKey) return "api_key";
    if (haveCursor) return "cursor_sdk";
  }
  // Multiple credentials present — keep the existing Claude-first preference
  // so existing setups don't suddenly switch to Cursor SDK billing without
  // an explicit user choice.
  if (haveSub) return "subscription";
  if (haveKey) return "api_key";
  if (haveCursor) return "cursor_sdk";
  return "api_key";
}

export function hasAnyAuth(options: AuthOptions): boolean {
  return options.apiKey.present || options.subscription.present || options.cursorSdk?.present === true;
}

/**
 * Interactive prompt. Returns the chosen mode or null if the user aborted.
 * Requires a TTY on stdin — callers must check `process.stdin.isTTY` first
 * and fall back to a non-interactive path otherwise.
 *
 * Choice 3 (Cursor SDK) is the only one that may need a follow-up paste:
 * if the user picks it but no key is configured yet, the caller is
 * responsible for running `promptCursorApiKey()` separately and persisting
 * via `saveCursorApiKey()` from auth-config.
 */
export async function promptAuthChoice(options: AuthOptions): Promise<AuthMode | null> {
  const def = defaultChoice(options);
  const defLabel = def === "subscription" ? "2" : def === "cursor_sdk" ? "3" : "1";

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Which should axme-code use? [1=api_key, 2=subscription, 3=cursor_sdk, default ${defLabel}]: `, resolve);
      });
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") return def;
      if (trimmed === "1" || trimmed === "api_key" || trimmed === "key") return "api_key";
      if (trimmed === "2" || trimmed === "subscription" || trimmed === "sub") return "subscription";
      if (trimmed === "3" || trimmed === "cursor_sdk" || trimmed === "cursor") return "cursor_sdk";
      if (trimmed === "q" || trimmed === "quit" || trimmed === "cancel") return null;
      process.stdout.write("  Enter 1, 2, 3, or q to cancel.\n");
    }
  } finally {
    rl.close();
  }
}

/**
 * Paste-once prompt for the Cursor SDK API key. Validates that the input
 * looks like a key (length >= 20, no whitespace inside). Returns the
 * trimmed key on success or null if the user aborted.
 */
export async function promptCursorApiKey(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question("Paste your Cursor SDK API key (or 'q' to cancel): ", resolve);
      });
      const trimmed = answer.trim();
      if (!trimmed) continue;
      if (trimmed === "q" || trimmed === "quit" || trimmed === "cancel") return null;
      if (trimmed.length < 20 || /\s/.test(trimmed)) {
        process.stdout.write("  That doesn't look like a valid API key. Try again or 'q' to cancel.\n");
        continue;
      }
      return trimmed;
    }
  } finally {
    rl.close();
  }
}
