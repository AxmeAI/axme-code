/**
 * Decision tools - axme_save_decision.
 */

import { addDecision, toSlug, listDecisions } from "../storage/decisions.js";
import type { Decision, EnforceLevel } from "../types.js";

export interface SaveDecisionInput {
  title: string;
  decision: string;
  reasoning: string;
  enforce?: EnforceLevel | null;
  scope?: string[];
}

export function saveDecisionTool(
  projectPath: string,
  input: SaveDecisionInput,
  sessionId?: string,
): { id: string; slug: string; saved: boolean } {
  const slug = toSlug(input.title);
  const today = new Date().toISOString().slice(0, 10);

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

  return { id: decision.id, slug: decision.slug, saved: true };
}
