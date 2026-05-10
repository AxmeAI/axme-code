/**
 * Detect available authentication options for LLM scanner subprocesses.
 *
 * Two mechanisms can authenticate the Claude Code binary that our scanners
 * spawn: (1) ANTHROPIC_API_KEY in env, which Claude Code picks up before
 * checking OAuth; (2) a Claude Code subscription session, stored either in
 * macOS Keychain or a credentials file under ~/.claude/ or ~/.config/claude/.
 *
 * Detection is offline and cheap — we do not probe the API, only check
 * environment variables, run `security` on macOS, and stat known paths.
 */

import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { pathExists, readSafe } from "../storage/engine.js";
import yaml from "js-yaml";
import { findClaudePath } from "./agent-options.js";

export interface ApiKeyOption {
  present: boolean;
  /** Masked representation for display, e.g. "sk-ant-...XXXX". */
  masked?: string;
}

export interface SubscriptionOption {
  present: boolean;
  /** Where we found evidence of a logged-in Claude Code session. */
  source?: "keychain" | "filesystem";
  /** Human-readable detail — Keychain service name or file path. */
  details?: string;
  /** True if the `claude` binary was found on PATH. */
  binaryFound: boolean;
}

export interface CursorSdkOption {
  /** True if a Cursor SDK API key is configured (env or cursor.yaml). */
  present: boolean;
  /** Where the key was found. */
  source?: "env" | "filesystem";
  /** Human-readable detail — env var name or file path. */
  details?: string;
  /** Masked representation for display. */
  masked?: string;
}

export interface AuthOptions {
  apiKey: ApiKeyOption;
  subscription: SubscriptionOption;
  cursorSdk?: CursorSdkOption;
}

function maskApiKey(key: string): string {
  const trimmed = key.trim();
  const last4 = trimmed.slice(-4);
  const prefix = trimmed.startsWith("sk-ant-") ? "sk-ant-" : "";
  return `${prefix}...${last4}`;
}

function maskCursorKey(key: string): string {
  const trimmed = key.trim();
  return `...${trimmed.slice(-4)}`;
}

function detectCursorSdk(): CursorSdkOption {
  // 1. Env var
  const envKey = process.env.CURSOR_API_KEY;
  if (envKey && envKey.trim()) {
    return {
      present: true,
      source: "env",
      details: "CURSOR_API_KEY",
      masked: maskCursorKey(envKey),
    };
  }
  // 2. ~/.config/axme-code/cursor.yaml — read inline (no agent-options import
  //    cycle through auth-config)
  const cursorYaml = join(homedir(), ".config", "axme-code", "cursor.yaml");
  if (pathExists(cursorYaml)) {
    try {
      const raw = readSafe(cursorYaml);
      const parsed = yaml.load(raw) as { apiKey?: string } | null;
      if (parsed && typeof parsed.apiKey === "string" && parsed.apiKey.trim()) {
        return {
          present: true,
          source: "filesystem",
          details: cursorYaml,
          masked: maskCursorKey(parsed.apiKey),
        };
      }
    } catch { /* fall through */ }
  }
  return { present: false };
}

function detectApiKey(): ApiKeyOption {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !key.trim()) return { present: false };
  return { present: true, masked: maskApiKey(key) };
}

function detectSubscriptionFromKeychain(): SubscriptionOption | null {
  if (process.platform !== "darwin") return null;
  try {
    const user = userInfo().username;
    // `security find-generic-password -s <service> -a <account>` exits 0 if
    // the item exists, non-zero otherwise. We do NOT reveal the secret.
    execFileSync("security", ["find-generic-password", "-s", "Claude Code", "-a", user], {
      stdio: "ignore",
    });
    return {
      present: true,
      source: "keychain",
      details: 'macOS Keychain entry "Claude Code"',
      binaryFound: true,
    };
  } catch {
    return null;
  }
}

function detectSubscriptionFromFilesystem(): SubscriptionOption | null {
  const home = homedir();
  const candidates = [
    join(home, ".claude", ".credentials.json"),
    join(home, ".config", "claude", ".credentials.json"),
  ];
  for (const path of candidates) {
    if (pathExists(path)) {
      return {
        present: true,
        source: "filesystem",
        details: path,
        binaryFound: true,
      };
    }
  }
  return null;
}

function detectSubscription(): SubscriptionOption {
  const binaryFound = Boolean(findClaudePath());
  if (!binaryFound) return { present: false, binaryFound: false };

  const fromKeychain = detectSubscriptionFromKeychain();
  if (fromKeychain) return fromKeychain;

  const fromFs = detectSubscriptionFromFilesystem();
  if (fromFs) return fromFs;

  return { present: false, binaryFound: true };
}

export function detectAuthOptions(): AuthOptions {
  return {
    apiKey: detectApiKey(),
    subscription: detectSubscription(),
    cursorSdk: detectCursorSdk(),
  };
}
