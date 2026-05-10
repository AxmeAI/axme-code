/**
 * User-level authentication mode config at ~/.config/axme-code/auth.yaml.
 *
 * Auth mode is a per-machine concern (which credential should Claude Code
 * subprocesses use), not a per-project one, so it lives outside the repo's
 * .axme-code/ storage. One choice applies to every project on this machine.
 *
 * The file stores only the selected mode and the timestamp of the choice.
 * `resolveAuthMode()` returns the persisted mode when present, otherwise
 * falls back to a detection-based heuristic without writing anything — so
 * non-interactive callers (scanner subprocesses, auditor) never surprise
 * the user by persisting a guessed choice.
 */

import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { atomicWrite, ensureDir, readSafe, pathExists } from "../storage/engine.js";
import type { AuthConfig, AuthMode, CursorApiKeyConfig } from "../types.js";
import { detectAuthOptions, type AuthOptions } from "./auth-detect.js";

/**
 * Resolve paths lazily (not at module load) so tests can swap $HOME between
 * cases without needing to bust the ESM module cache.
 */
function configDir(): string {
  return join(homedir(), ".config", "axme-code");
}

export function authConfigPath(): string {
  return join(configDir(), "auth.yaml");
}

/** Path to the Cursor SDK API key file. The key lives separately from
 *  auth.yaml so we can chmod 600 the secret without locking down the
 *  mode flag. */
export function cursorApiKeyPath(): string {
  return join(configDir(), "cursor.yaml");
}

const VALID_AUTH_MODES: ReadonlyArray<AuthMode> = ["subscription", "api_key", "cursor_sdk"];

export function loadAuthConfig(): AuthConfig | null {
  const file = authConfigPath();
  if (!pathExists(file)) return null;
  const raw = readSafe(file);
  if (!raw) return null;
  try {
    const parsed = yaml.load(raw) as Partial<AuthConfig> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (!VALID_AUTH_MODES.includes(parsed.mode as AuthMode)) return null;
    const chosenAt = typeof parsed.chosenAt === "string" ? parsed.chosenAt : new Date().toISOString();
    return { mode: parsed.mode as AuthMode, chosenAt };
  } catch {
    return null;
  }
}

export function saveAuthConfig(mode: AuthMode): AuthConfig {
  ensureDir(configDir());
  const config: AuthConfig = { mode, chosenAt: new Date().toISOString() };
  atomicWrite(authConfigPath(), yaml.dump(config));
  return config;
}

/**
 * Read the Cursor SDK API key from cursor.yaml. Returns null if not
 * configured. Callers (Cursor SDK adapter) should ALSO check
 * process.env.CURSOR_API_KEY as a fallback so users can override via env
 * without rewriting the config.
 */
export function loadCursorApiKey(): string | undefined {
  const file = cursorApiKeyPath();
  if (!pathExists(file)) return undefined;
  const raw = readSafe(file);
  if (!raw) return undefined;
  try {
    const parsed = yaml.load(raw) as Partial<CursorApiKeyConfig> | null;
    if (!parsed || typeof parsed !== "object") return undefined;
    const key = parsed.apiKey;
    if (typeof key !== "string" || !key.trim()) return undefined;
    return key.trim();
  } catch {
    return undefined;
  }
}

/**
 * Persist the Cursor SDK API key to cursor.yaml with mode 0600 so other
 * users on the machine cannot read it. The mode flag in auth.yaml is
 * NOT touched here — call saveAuthConfig("cursor_sdk") separately.
 */
export function saveCursorApiKey(apiKey: string): CursorApiKeyConfig {
  ensureDir(configDir());
  const config: CursorApiKeyConfig = { apiKey: apiKey.trim(), chosenAt: new Date().toISOString() };
  const path = cursorApiKeyPath();
  atomicWrite(path, yaml.dump(config));
  // Best-effort permission lock; on Windows chmod is a no-op and the file
  // inherits the directory's ACLs (ACL inheritance from %USERPROFILE%
  // already excludes other users, so this is safe-by-default there).
  try { chmodSync(path, 0o600); } catch { /* swallow on Windows */ }
  return config;
}

/**
 * Choose the sensible default when no saved choice exists and we can't ask
 * the user. If an API key is set (regardless of subscription state) we keep
 * the existing behavior: pass env through to Claude Code and let it decide.
 * If only subscription is available, prefer it. If only a Cursor SDK key
 * is available (cursor.yaml present OR CURSOR_API_KEY env), prefer it.
 * If neither, return api_key so we fail the same way Claude Code would
 * fail on its own.
 */
function heuristicMode(options: AuthOptions): AuthMode {
  if (options.subscription.present && !options.apiKey.present && !options.cursorSdk?.present) return "subscription";
  if (options.cursorSdk?.present && !options.apiKey.present && !options.subscription.present) return "cursor_sdk";
  return "api_key";
}

/**
 * Effective auth mode for a scanner call. Reads the saved config if present,
 * otherwise returns a heuristic without persisting anything.
 */
export function resolveAuthMode(): AuthMode {
  const saved = loadAuthConfig();
  if (saved) return saved.mode;
  return heuristicMode(detectAuthOptions());
}
