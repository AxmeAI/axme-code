/**
 * The canonical knowledge-base authoring contract, in one place.
 *
 * Why a shared module rather than a paragraph in each prompt: this guidance
 * has to appear in five separate write paths — the MCP tool descriptions,
 * the CLAUDE.md template, the Cursor rules, the session auditor, and the
 * memory extractor. Duplicated prose drifts, and drift here is expensive:
 * before v0.6.4 the extractor prompt actively contradicted the contract
 * ("body: keep short or omit — description must carry all meaning"), which
 * is precisely the instruction that put 91% of one base's memories into the
 * layer that is paid for by every session.
 *
 * The markdown templates in cli.ts / cursor-writers.ts render for a human
 * reading CLAUDE.md and keep their own phrasing; everything that is fed to
 * an LLM as a prompt fragment comes from here.
 */

/**
 * The two-level format, addressed to an agent that is about to write an entry.
 *
 * @param excerptChars The project's catalog excerpt width (config
 *        `catalog.excerpt_chars`). Passed in rather than read here so the
 *        number an agent is told matches the number the catalog will apply.
 */
export function twoLevelFormatRule(excerptChars: number): string {
  return `==== THE TWO-LEVEL FORMAT (applies to every memory and decision) ====

Each entry has a layer that is loaded into EVERY future session and a layer that is not:

  LOADED    memory "description" / decision "decision"
            Rendered into every session's starting context. This is the only part that costs.
            Budget: ${excerptChars} characters. Past that it is CUT from the session-start
            catalog and the remainder is invisible unless someone explicitly fetches it.

  DEFERRED  memory "body" / decision "reasoning"
            Rendered as "## Details" / "## Reasoning". NOT loaded at session start.
            Returned in full by axme_get_memory(slug) / axme_get_decision(id).
            Costs nothing per session, so use it freely.

So: put the RULE plus ONE concrete fact in the loaded layer, and put every number,
file path, line reference, threshold, measurement and command output in the deferred
layer. Nothing is lost by moving detail down — it simply stops being paid for by the
sessions that never needed it.

An entry whose loaded layer fits the budget renders COMPLETE in the catalog, which is
what makes a large knowledge base affordable at all.

Do NOT split one entry into several single-fact entries to meet the budget. Per-entry
overhead (slug, title, catalog markup) is 60-100 characters and multiplies by count, so
splitting makes the base bigger while scattering facts that belong together. Cut DOWN
into the deferred layer, never ACROSS into more records.`;
}

/**
 * The selection test, addressed to an agent deciding whether to save at all.
 *
 * The negative list is the operative half. The template this replaces said
 * only "error pattern or successful approach discovered -> save immediately",
 * under which every positive research result qualifies; a month of that put
 * 110 research diaries and 18 session handoffs into one base's memory.
 */
export const SELECTION_TEST = `==== WHAT BELONGS IN MEMORY (ask before every candidate) ====

Would this help an agent a MONTH FROM NOW who was not part of this investigation?
If the value is in the numbers rather than in a rule, it is a document, not a memory.

SAVE:
- a rule or ruling from the user
- vendor / feed / API semantics that will not be re-derived (sign convention, error
  codes, limits, cadence)
- a tool or language trap that will recur
- a closed direction, recorded so nobody reopens it
- a live production contract

DO NOT SAVE:
- measurement results and verdict numbers — those belong in a doc; a memory may carry
  at most one line pointing to it
- session state, handoffs, "where we stopped" — the handoff section already stores that,
  and a handoff in memory is read by every future session forever
- research diaries ("day 3 of B-008", "wave 2 of the basketball run")
- a one-off incident whose fix is already in the code and that yields no transferable rule
- anything an existing entry already covers — extend that entry instead of adding a second`;

/**
 * Instruction against meta-decisions.
 *
 * One prior audit produced nine of these ("D-020 absorbed by D-036",
 * "D-024: recorders now run as 9 systemd units"). They are edits to other
 * decisions wearing the shape of decisions, and the edits had already been
 * applied — so each record cost context to restate a fact already stored.
 */
export const NO_META_DECISIONS = `Do NOT emit a decision whose content is a statement ABOUT other decisions —
"D-020 absorbed by D-036", "D-024 updated to reflect the new topology". Those are edits,
not decisions: make the edit in the decisions themselves (action=supersede, or
axme_archive_decision with superseded_by) instead of recording that an edit happened.`;
