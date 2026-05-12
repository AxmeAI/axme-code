/**
 * Live read of ~/.cursor/hooks.json to confirm AXME entries are present.
 *
 * The sidebar previously inferred "hooks ok / missing" from the activation
 * ActivationReport, which captured one moment in time. After a user
 * reinstalls or reset and reinstalls hooks, the report stays stale until
 * the next window reload. Reading the file on demand is cheap and never
 * lies — if the entries exist on disk, the hook will fire next tool call.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function hooksAreInstalled(): boolean {
  const p = join(homedir(), ".cursor", "hooks.json");
  if (!existsSync(p)) return false;
  try {
    const raw = readFileSync(p, "utf-8");
    // We don't fully parse the schema here — a substring match on the
    // binary name and any of the three lifecycle hook keys is enough to
    // tell "AXME left its fingerprints in this file". installUserHooks
    // is the canonical writer; if it has run successfully, all three
    // keys will be present with our command path.
    const parsed = JSON.parse(raw);
    const hooks = parsed?.hooks;
    if (!hooks || typeof hooks !== "object") return false;
    for (const kind of ["preToolUse", "postToolUse", "sessionEnd"] as const) {
      const list = hooks[kind];
      if (!Array.isArray(list)) return false;
      const hasAxme = list.some(
        (entry: { command?: unknown }) =>
          typeof entry?.command === "string" && entry.command.includes("axme-code"),
      );
      if (!hasAxme) return false;
    }
    return true;
  } catch {
    return false;
  }
}
