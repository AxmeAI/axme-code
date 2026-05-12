/**
 * Auditor mode config — a single-line file at
 * `~/.config/axme-code/auditor-mode`.
 *
 * The mode is set by the Cursor extension's sidebar dropdown (v0.0.3+).
 * Two values, both valid:
 *   - "cooperative"  → no background LLM. Memories/decisions/safety are
 *                      saved inline by the agent in the chat using the
 *                      user's Cursor subscription. Default for Cursor
 *                      extension users so there's no extra LLM billing
 *                      out of the box.
 *   - "background"   → spawn the detached audit worker after each chat,
 *                      using whichever credential resolveAuthMode()
 *                      reports. This is the historical behaviour and the
 *                      default for Claude Code CLI users (who already
 *                      have a subscription via the claude binary).
 *
 * Missing file = "background" so existing CLI installs keep behaving as
 * before. The Cursor extension's installer writes "cooperative" on first
 * activation to apply the new default for fresh installs.
 *
 * Kept intentionally minimal (no YAML, no schema migration) — one byte
 * decision, no need for ceremony.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AuditorMode = "cooperative" | "background";
const VALID: ReadonlyArray<AuditorMode> = ["cooperative", "background"];

export function auditorModePath(): string {
  return join(homedir(), ".config", "axme-code", "auditor-mode");
}

export function loadAuditorMode(): AuditorMode {
  const p = auditorModePath();
  if (!existsSync(p)) return "background";
  try {
    const raw = readFileSync(p, "utf-8").trim();
    return (VALID as ReadonlyArray<string>).includes(raw) ? (raw as AuditorMode) : "background";
  } catch {
    return "background";
  }
}

export function saveAuditorMode(mode: AuditorMode): void {
  const p = auditorModePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, mode + "\n", "utf-8");
  try { chmodSync(p, 0o644); } catch { /* non-fatal */ }
}
