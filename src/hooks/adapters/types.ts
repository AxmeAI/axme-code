/**
 * Shared types for IDE-specific hook input parsers and deny-output emitters.
 *
 * Both Claude Code and Cursor hooks deliver per-event JSON to the hook
 * subprocess on stdin, but the field names, the deny-response shape, and the
 * exit-code semantics differ. The adapter pattern keeps the safety-checking
 * core logic in pre-tool-use.ts byte-identical across IDEs and isolates the
 * IDE-specific shapes here.
 */

import type { IdeKind } from "../../types.js";

export type HookKind = "preToolUse" | "postToolUse" | "sessionEnd";

/**
 * The IDE-agnostic shape of a hook event after parsing. Hook handlers in
 * src/hooks/* read from this type instead of touching raw IDE-specific keys.
 */
export interface NormalizedHookEvent {
  kind: HookKind;
  ide: IdeKind;
  /** PreToolUse / PostToolUse only — the tool the agent is about to run. */
  toolName?: string;
  /** PreToolUse / PostToolUse only — the arguments the agent passed. */
  toolInput?: Record<string, unknown>;
  /** IDE's own session id (Claude Code session_id, Cursor session_id, etc.). */
  sessionId?: string;
  /** Path to the IDE's transcript file, if any. May be null on Cursor. */
  transcriptPath?: string | null;
  /** SessionEnd only — Cursor reports a `reason` (completed/aborted/...). */
  reason?: string;
  /** The original parsed JSON, for debug logging or fallback inspection. */
  raw: Record<string, unknown>;
}

/** Parses a raw stdin JSON value into a NormalizedHookEvent. */
export interface HookInputAdapter {
  parse(raw: unknown, kind: HookKind): NormalizedHookEvent;
}

/** Result of an IDE-specific deny: stdout payload + exit code to use. */
export interface DenyResult {
  stdout: string;
  exitCode: number;
}

/** Emits a deny response in the IDE's native protocol. */
export interface HookOutputAdapter {
  emitDeny(reason: string, kind: HookKind): DenyResult;
}
