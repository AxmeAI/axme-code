/**
 * IDE detection — picks which IDE produced a hook event so the right adapter
 * (and later the right LLM SDK) is selected.
 *
 * Resolution order:
 *   1. explicit --ide flag in argv (always wins)
 *   2. AXME_IDE env var
 *   3. heuristic peek at parsed hook stdin (cursor_version / workspace_roots
 *      keys are Cursor-only)
 *   4. default "claude-code" — keeps every existing setup unaffected
 *
 * The setup writers always emit `--ide cursor` explicitly in
 * `.cursor/hooks.json` commands, so the heuristic path is only a defence-
 * in-depth fallback for older configs.
 */

import type { IdeKind } from "../types.js";

export type { IdeKind };

const IDE_VALUES: ReadonlyArray<IdeKind> = ["claude-code", "cursor"];

/**
 * Parse `--ide <kind>` or `--ide=<kind>` out of an argv array.
 * Returns undefined if absent. Unknown values are ignored.
 */
export function parseIdeFlag(args: readonly string[]): IdeKind | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--ide" && i + 1 < args.length) {
      const v = args[i + 1];
      if (IDE_VALUES.includes(v as IdeKind)) return v as IdeKind;
    } else if (a.startsWith("--ide=")) {
      const v = a.slice("--ide=".length);
      if (IDE_VALUES.includes(v as IdeKind)) return v as IdeKind;
    }
  }
  return undefined;
}

/** Read AXME_IDE env var. Unknown values are ignored. */
export function detectIdeFromEnv(env: NodeJS.ProcessEnv = process.env): IdeKind | undefined {
  const v = env.AXME_IDE;
  if (v && IDE_VALUES.includes(v as IdeKind)) return v as IdeKind;
  return undefined;
}

/**
 * Peek at parsed hook stdin and infer Cursor vs Claude Code by which keys
 * are present. Cursor's hook payload always carries `cursor_version` and
 * `workspace_roots`; Claude Code's never does.
 */
export function detectIdeFromHookStdin(raw: unknown): IdeKind | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.cursor_version === "string") return "cursor";
  if (Array.isArray(obj.workspace_roots)) return "cursor";
  // Claude Code has no equivalent unique top-level key, so we only
  // positively identify Cursor here.
  return undefined;
}

/**
 * Resolve the effective IDE for the current invocation.
 * Order: argv flag → env var → stdin heuristic → "claude-code".
 */
export function resolveIde(
  args: readonly string[],
  hookRaw?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): IdeKind {
  return parseIdeFlag(args)
    ?? detectIdeFromEnv(env)
    ?? detectIdeFromHookStdin(hookRaw)
    ?? "claude-code";
}
