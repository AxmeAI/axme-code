/**
 * Strip leaked tool-call markup out of knowledge-base text fields.
 *
 * Observed in the wild: three memory files whose body ended with
 *
 *   ...through watchdog.</description>
 *   <parameter name="keywords">["bf_live", "date rollover", "watchdog"]
 *
 * i.e. the client serialized one tool argument and the XML frame of the
 * NEXT argument into the same string. The MCP layer cannot prevent a
 * malformed emission upstream, so the storage layer refuses to persist it:
 * everything from the first stray closing/parameter tag onward is dropped,
 * because that text belongs to a different argument, not to this one.
 *
 * Deliberately conservative — it only recognises the specific frame shapes
 * the Claude Code tool-call serializer emits. Ordinary prose containing
 * "<" or a code snippet with real HTML is left untouched.
 */

/** Tags that mark the end of one argument's payload in a leaked frame. */
const LEAK_START = /<\/(?:description|parameter|body|decision|reasoning|title|invoke|function_calls)>|<parameter\s+name=|<parameter\s|<\/antml:/i;

export interface SanitizeResult {
  text: string;
  /** True when markup was found and removed — callers surface this to the agent. */
  changed: boolean;
}

/**
 * Remove a leaked tool-call frame from a single field value.
 *
 * Returns the text up to the first leak marker, trimmed. If no marker is
 * present the input is returned unchanged (and `changed` is false), so this
 * is safe to run over every write.
 */
export function stripLeakedMarkup(text: string): SanitizeResult {
  if (!text) return { text, changed: false };
  const m = LEAK_START.exec(text);
  if (!m) return { text, changed: false };
  const cut = text.slice(0, m.index).replace(/\s+$/, "");
  return { text: cut, changed: true };
}

/** True when the text carries a leaked tool-call frame. Used by kb-doctor. */
export function hasLeakedMarkup(text: string): boolean {
  return !!text && LEAK_START.test(text);
}

/**
 * Sanitize every text field of a record, reporting which fields were cut.
 * Field order in the result is the caller's; only present fields are visited.
 */
export function sanitizeFields<T extends object>(
  record: T,
  fields: Array<keyof T & string>,
): { record: T; cleaned: string[] } {
  const out = { ...record } as Record<string, unknown>;
  const cleaned: string[] = [];
  for (const f of fields) {
    const v = out[f];
    if (typeof v !== "string") continue;
    const r = stripLeakedMarkup(v);
    if (r.changed) {
      out[f] = r.text;
      cleaned.push(f);
    }
  }
  return { record: out as T, cleaned };
}
