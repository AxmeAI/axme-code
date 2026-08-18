/**
 * Decision tools - axme_save_decision.
 */

import { addDecision, toSlug, listDecisions } from "../storage/decisions.js";
import { readConfig } from "../storage/config.js";
import { checkOverrun, findDuplicateCandidates, formatDuplicateNote } from "../storage/save-feedback.js";
import type { Decision, EnforceLevel } from "../types.js";

export interface SaveDecisionInput {
  title: string;
  decision: string;
  reasoning: string;
  enforce?: EnforceLevel | null;
  scope?: string[];
}

export interface SaveDecisionResult {
  id: string;
  slug: string;
  saved: boolean;
  /** Advisory lines appended to the tool result — format and dedup guidance. */
  notes: string[];
}

export function saveDecisionTool(
  projectPath: string,
  input: SaveDecisionInput,
  sessionId?: string,
): SaveDecisionResult {
  const slug = toSlug(input.title);
  const today = new Date().toISOString().slice(0, 10);
  const config = readConfig(projectPath);
  const candidates = findDuplicateCandidates(projectPath, "decision", input.title);

  const decision = addDecision(projectPath, {
    slug,
    title: input.title,
    decision: input.decision,
    reasoning: input.reasoning,
    date: today,
    source: "session",
    enforce: input.enforce ?? null,
    sessionId: sessionId ?? null,
    ...(input.scope ? { scope: input.scope } : {}),
  });

  const notes: string[] = [];
  // addDecision returns the EXISTING record when a title-equivalent one is
  // already stored. Saying so matters: the agent otherwise reads "Decision
  // saved" and believes its new wording landed, when nothing changed.
  if (decision.date !== today || decision.sessionId !== (sessionId ?? null)) {
    notes.push(
      `NOTE: an equivalent decision already existed (${decision.id} — ${decision.title}) and was returned unchanged; ` +
      `nothing new was written. To revise it, use axme_archive_decision on the old one and save the replacement, ` +
      `or save under a distinctly different title.`,
    );
  }
  notes.push(...checkOverrun({
    kind: "decision",
    loadedText: input.decision,
    hasBody: !!input.reasoning?.trim(),
    excerptChars: config.catalogExcerptChars,
  }));
  notes.push(...formatDuplicateNote("decision", candidates.filter(c => c.ref !== decision.id)));

  return { id: decision.id, slug: decision.slug, saved: true, notes };
}
