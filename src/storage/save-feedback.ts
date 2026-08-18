/**
 * Post-write advice returned to the agent by axme_save_memory /
 * axme_save_decision.
 *
 * The problem this solves: the format contract ("description = 1-2
 * sentences, details go in body") was stated in the tool description and
 * in the audit prompt, and enforced nowhere. Measured outcome on a real
 * project — 91% of memories put everything into the loaded layer, average
 * 212 words against a stated 1-2 sentences, and `## Details` non-empty in
 * 11 records out of 126. A rule nothing ever checks is a suggestion.
 *
 * This is deliberately advisory, not a rejection. Refusing an overlong
 * save would lose the content the agent just composed — the agent has no
 * cheap way to retry a long payload, and a dropped memory is worse than a
 * verbose one. So the write always lands, and the result text tells the
 * agent exactly what happened and what to do about it next time.
 */

import { listMemories } from "./memory.js";
import { listDecisions } from "./decisions.js";

export interface SaveAdvice {
  /** Lines appended to the tool result, in order. Empty when all is well. */
  notes: string[];
}

export interface OverrunInput {
  kind: "memory" | "decision";
  /** The field that gets rendered into the session-start catalog. */
  loadedText: string;
  /** Whether the caller supplied the deferred-detail field. */
  hasBody: boolean;
  excerptChars: number;
}

/**
 * Report a description/decision that overruns the catalog excerpt width.
 *
 * The message names the concrete numbers rather than restating the rule:
 * an agent that just wrote 1180 characters already believed it was being
 * concise, so "1180 vs 200, the last 980 are invisible" changes behaviour
 * in a way "keep it to 1-2 sentences" demonstrably did not.
 */
export function checkOverrun(input: OverrunInput): string[] {
  const len = input.loadedText.length;
  if (len <= input.excerptChars) return [];

  const field = input.kind === "memory" ? "description" : "decision";
  const detail = input.kind === "memory" ? "body (rendered as \"## Details\")" : "reasoning (rendered as \"## Reasoning\")";
  const hidden = len - input.excerptChars;

  const notes = [
    `NOTE: ${field} is ${len} chars; the session-start catalog renders ${input.excerptChars}. ` +
    `The last ${hidden} chars will NOT be visible to future sessions unless they explicitly call ` +
    `${input.kind === "memory" ? "axme_get_memory" : "axme_get_decision"}.`,
    `Fix: keep ${field} to the rule plus one concrete fact (<=${input.excerptChars} chars) and move the numbers, ` +
    `paths, measurements and line references into \`${detail}\` — that field costs nothing at session start ` +
    `and is returned in full on demand.`,
  ];
  if (!input.hasBody) {
    notes.push(`You left ${input.kind === "memory" ? "body" : "reasoning"} empty, so all of this is currently in the paid layer.`);
  }
  return notes;
}

export interface DuplicateCandidate {
  ref: string;
  title: string;
  score: number;
}

/**
 * Find existing entries that look like the one being saved.
 *
 * Token-overlap on the title, not semantic search: this runs inside the
 * save path on every call, so it must be synchronous and free. The
 * embeddings index would be a better judge, but loading it costs 50-200ms
 * and it is absent in `full` mode, where duplicates accumulate fastest.
 * Overlap is crude but catches the dominant real case — the same rule
 * re-extracted by a later session under a near-identical title.
 */
export function findDuplicateCandidates(
  projectPath: string, kind: "memory" | "decision", title: string, limit = 3,
): DuplicateCandidate[] {
  const incoming = tokenize(title);
  if (incoming.size === 0) return [];

  const entries: Array<{ ref: string; title: string }> = kind === "memory"
    ? listMemories(projectPath).map(m => ({ ref: m.slug, title: m.title }))
    : listDecisions(projectPath).map(d => ({ ref: d.id, title: d.title }));

  const scored: DuplicateCandidate[] = [];
  for (const e of entries) {
    const other = tokenize(e.title);
    if (other.size === 0) continue;
    let shared = 0;
    for (const t of incoming) if (other.has(t)) shared++;
    // Jaccard over content words. 0.5 means half the distinctive words of
    // both titles coincide — below that the hit rate on real bases was
    // mostly noise ("git" and "branch" match everything).
    const score = shared / (incoming.size + other.size - shared);
    if (score >= 0.5) scored.push({ ref: e.ref, title: e.title, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Render duplicate candidates as agent-facing advice. */
export function formatDuplicateNote(
  kind: "memory" | "decision", candidates: DuplicateCandidate[],
): string[] {
  if (candidates.length === 0) return [];
  const getter = kind === "memory" ? "axme_get_memory" : "axme_get_decision";
  const lines = [
    `NOTE: ${candidates.length} existing ${kind}(s) have a very similar title:`,
    ...candidates.map(c => `  - ${c.ref} — ${c.title}`),
    `If one of these covers the same ground, prefer EXTENDING it (read it with ${getter}, then save again ` +
    `under its exact title to replace it) over leaving two near-duplicates. Two half-records cost more ` +
    `context than one complete one and contradict each other as they age.`,
  ];
  return lines;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "in", "for", "on", "to", "with", "at",
  "by", "from", "is", "are", "be", "not", "no", "must", "should", "always",
  "never", "use", "using", "when", "via",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w)),
  );
}
