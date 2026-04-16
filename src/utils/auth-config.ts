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

import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { atomicWrite, ensureDir, readSafe, pathExists } from "../storage/engine.js";
import type { AuthConfig, AuthMode } from "../types.js";
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

export function loadAuthConfig(): AuthConfig | null {
  const file = authConfigPath();
  if (!pathExists(file)) return null;
  const raw = readSafe(file);
  if (!raw) return null;
  try {
    const parsed = yaml.load(raw) as Partial<AuthConfig> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.mode !== "subscription" && parsed.mode !== "api_key") return null;
    const chosenAt = typeof parsed.chosenAt === "string" ? parsed.chosenAt : new Date().toISOString();
    return { mode: parsed.mode, chosenAt };
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
 * Choose the sensible default when no saved choice exists and we can't ask
 * the user. If an API key is set (regardless of subscription state) we keep
 * the existing behavior: pass env through to Claude Code and let it decide.
 * If only subscription is available, prefer it. If neither, return api_key
 * so we fail the same way Claude Code would fail on its own.
 */
function heuristicMode(options: AuthOptions): AuthMode {
  if (options.subscription.present && !options.apiKey.present) return "subscription";
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
