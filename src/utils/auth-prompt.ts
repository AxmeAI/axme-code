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
  return lines.join("\n");
}

function defaultChoice(options: AuthOptions): AuthMode {
  if (options.subscription.present && !options.apiKey.present) return "subscription";
  if (options.apiKey.present && !options.subscription.present) return "api_key";
  return options.subscription.present ? "subscription" : "api_key";
}

export function hasAnyAuth(options: AuthOptions): boolean {
  return options.apiKey.present || options.subscription.present;
}

/**
 * Interactive prompt. Returns the chosen mode or null if the user aborted.
 * Requires a TTY on stdin — callers must check `process.stdin.isTTY` first
 * and fall back to a non-interactive path otherwise.
 */
export async function promptAuthChoice(options: AuthOptions): Promise<AuthMode | null> {
  const def = defaultChoice(options);
  const defLabel = def === "subscription" ? "2" : "1";

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Which should axme-code use? [1=api_key, 2=subscription, default ${defLabel}]: `, resolve);
      });
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") return def;
      if (trimmed === "1" || trimmed === "api_key" || trimmed === "key") return "api_key";
      if (trimmed === "2" || trimmed === "subscription" || trimmed === "sub") return "subscription";
      if (trimmed === "q" || trimmed === "quit" || trimmed === "cancel") return null;
      process.stdout.write("  Enter 1, 2, or q to cancel.\n");
    }
  } finally {
    rl.close();
  }
}
