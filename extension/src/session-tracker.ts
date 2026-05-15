/**
 * Picks the currently-active chat session for the sidebar's "Current session"
 * block and reports tokens / duration / message count from the on-disk
 * transcript.
 *
 * "Active" = the session whose `.axme-code/active-sessions/<sid>.txt` mapping
 * file was most recently written. The pre/post tool-use hooks rewrite that
 * file every time they fire (atomicWrite always replaces), so the mtime
 * tracks chat activity at near-real-time granularity. This lets the sidebar
 * follow Cursor users as they switch between chat tabs without us needing
 * any private Cursor API to enumerate them.
 *
 * Token counting is an approximation: `Math.ceil(chars / 3.5)` is the
 * canonical Claude rule-of-thumb (BPE tokenizers actually compress prose
 * slightly better than English fixed-ratio, but the variance is within
 * ±10% which is fine for "you have X tokens / 200k" UI). We deliberately
 * don't pull tiktoken — it adds ~800 KB of WASM and we'd still be wrong
 * for non-OpenAI models. The Cursor JSONL does not expose the chosen model
 * (verified 2026-05-12), so a precise tokenizer wouldn't help anyway.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ActiveSession {
  /** AXME session id (UUID) — directory under .axme-code/sessions/. */
  axmeSessionId: string;
  /** Source IDE session id (Cursor chat uuid or Claude Code session uuid). */
  ideSessionId: string;
  /** Path to the JSONL transcript file, if known. */
  transcriptPath?: string;
  /** ISO timestamp when the IDE session first hit AXME (best proxy for "chat started"). */
  startedAt: string;
  /** Live token estimate, computed from the transcript. */
  tokens: number;
  /** Message count (user + assistant + tool combined) from the transcript. */
  messages: number;
  /** True if the transcript parsed had ANY content — false implies the session is fresh / empty. */
  hasData: boolean;
}

const APPROX_CHARS_PER_TOKEN = 3.5;

export function readActiveSession(workspaceRoot: string): ActiveSession | null {
  const mappingDir = join(workspaceRoot, ".axme-code", "active-sessions");
  if (!existsSync(mappingDir)) return null;
  let files: string[];
  try {
    files = readdirSync(mappingDir).filter((f) => f.endsWith(".txt"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  // Pick most-recently-written mapping. Each hook fire rewrites these via
  // atomicWrite, so the mtime is essentially "most recent tool call".
  let best: { path: string; mtime: number; ide: string } | undefined;
  for (const f of files) {
    const p = join(mappingDir, f);
    try {
      const m = statSync(p).mtimeMs;
      if (!best || m > best.mtime) {
        best = { path: p, mtime: m, ide: f.replace(/\.txt$/, "") };
      }
    } catch { /* skip */ }
  }
  if (!best) return null;

  let mapping: { axmeSessionId?: string } = {};
  try { mapping = JSON.parse(readFileSync(best.path, "utf-8")); } catch { /* skip */ }
  if (!mapping.axmeSessionId) return null;

  const metaPath = join(workspaceRoot, ".axme-code", "sessions", mapping.axmeSessionId, "meta.json");
  let meta: SessionMetaShape = { id: mapping.axmeSessionId };
  try { meta = JSON.parse(readFileSync(metaPath, "utf-8")); } catch { /* tolerate */ }

  const ref = pickIdeSessionRef(meta, best.ide);
  const transcriptPath = ref?.transcriptPath;
  const startedAt = ref?.firstSeen ?? meta.createdAt ?? new Date(best.mtime).toISOString();

  const counts = transcriptPath ? countTokens(transcriptPath) : { tokens: 0, messages: 0, hasData: false };

  return {
    axmeSessionId: mapping.axmeSessionId,
    ideSessionId: best.ide,
    transcriptPath,
    startedAt,
    tokens: counts.tokens,
    messages: counts.messages,
    hasData: counts.hasData,
  };
}

interface IdeSessionRef {
  id: string;
  transcriptPath?: string;
  firstSeen?: string;
}
interface SessionMetaShape {
  id: string;
  createdAt?: string;
  claudeSessions?: IdeSessionRef[];
}

function pickIdeSessionRef(meta: SessionMetaShape, ideSessionId: string): IdeSessionRef | undefined {
  return meta.claudeSessions?.find((s) => s.id === ideSessionId) ?? meta.claudeSessions?.[0];
}

function countTokens(transcriptPath: string): { tokens: number; messages: number; hasData: boolean } {
  if (!existsSync(transcriptPath)) return { tokens: 0, messages: 0, hasData: false };
  let chars = 0, messages = 0;
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const stringified = JSON.stringify(obj.message ?? obj);
        chars += stringified.length;
        messages++;
      } catch {
        chars += line.length;
      }
    }
  } catch { /* fall through to zeros */ }
  return {
    tokens: Math.ceil(chars / APPROX_CHARS_PER_TOKEN),
    messages,
    hasData: chars > 0,
  };
}
