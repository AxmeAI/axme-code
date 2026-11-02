/**
 * SessionStart hook — Codex only (Claude Code gets the same nudge from the
 * plugin's `check-init` subcommand, Cursor from the extension).
 *
 * Codex injects whatever a SessionStart hook prints on stdout into the
 * session as developer context. We use that to deliver the one line the
 * agent must act on before anything else: call axme_context. No files are
 * written here — AGENTS.md already carries the full instructions; this is
 * the per-session reminder that survives even when the agent skims it.
 *
 * Output is plain text on purpose (not the hookSpecificOutput JSON form):
 * both reach the model, and plain text cannot be mis-parsed.
 */

import { configExists } from "../storage/config.js";

export async function runSessionStartHook(workspacePath?: string): Promise<void> {
  if (process.env.AXME_SKIP_HOOKS === "1") return;

  let cwdFromStdin: string | undefined;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { cwd?: unknown };
    if (typeof raw.cwd === "string") cwdFromStdin = raw.cwd;
  } catch {
    // Empty or non-JSON stdin is fine — --workspace / cwd fallback below.
  }

  const root = workspacePath ?? cwdFromStdin ?? process.cwd();
  if (configExists(root)) {
    process.stdout.write("[AXME Code] Knowledge base ready. Call axme_context now.\n");
  } else {
    process.stdout.write(
      "[AXME Code] Project not initialized. Ask the user to run `axme-code setup --ide=codex` " +
        "in a terminal, then start a new Codex session.\n",
    );
  }
}
