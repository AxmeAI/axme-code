/**
 * Cooperative chat-prompt helpers.
 *
 * Cursor's extension API does not expose `cursor.chat.send(text)` or
 * `vscode.chat.invoke()` — there is no documented way for a third-party
 * extension to programmatically place a message into an active chat
 * input. The closest primitives we have are:
 *
 *   1. Cursor's internal `cursor.chat.newChat` command, observed in a
 *      handful of community Open VSX extensions to open a fresh chat
 *      tab. Not documented, may change between versions — wrap in
 *      try/catch and never depend on its existence.
 *   2. VS Code 1.101+'s `workbench.action.chat.open` with a `query`
 *      parameter, which DOES pre-fill the input. Doesn't exist in Cursor
 *      (separate chat engine).
 *   3. The clipboard via `vscode.env.clipboard.writeText` — works
 *      universally and is what we rely on as the always-available path.
 *
 * Behaviour: copy the prompt to the clipboard, fire-and-forget try the
 * two open-chat command IDs above (so a fresh tab is ready to paste
 * into), and surface a non-modal toast telling the user to paste.
 *
 * Why not full automation: blocking on something undocumented (case 1)
 * would make every "[Run setup]" click hang on rare Cursor builds where
 * the command does not exist. Copying-to-clipboard always succeeds, and
 * Cmd+L → Cmd+V is two keystrokes — acceptable UX cost for reliability.
 */

import * as vscode from "vscode";

export interface ChatPromptOptions {
  /** Short label for the toast (e.g. "setup prompt"). */
  label: string;
  /** Full multi-line prompt body to copy to clipboard. */
  body: string;
}

export async function deliverChatPrompt(opts: ChatPromptOptions): Promise<void> {
  await vscode.env.clipboard.writeText(opts.body);

  // Earlier drafts also fired cursor.chat.newChat to spawn a fresh chat
  // tab. Removed after user feedback: the user is almost always already
  // in a chat when they click [Ask agent to setup] — opening a new tab
  // moves them off their current context and feels broken.
  //
  // The clipboard-only path used to surface its result with a corner
  // toast, which users reported was "microscopic" and easy to miss.
  // Use a modal dialog instead: it forces a deliberate "OK" click before
  // execution continues, so there is no scenario where the user clicks
  // the sidebar button and then wonders if anything happened.
  void vscode.window.showInformationMessage(
    `Prompt copied to clipboard.\n\n` +
      `Next: open or focus a Cursor chat (Cmd/Ctrl+L), paste with Cmd/Ctrl+V, ` +
      `and hit Enter. The agent will perform the ${opts.label.replace(/ prompt$/, "")} flow ` +
      `inline using your Cursor subscription — no extra API key needed.`,
    { modal: true },
    "Got it",
  );
}

/**
 * Prompt that asks the agent to perform the workspace setup. Used by the
 * sidebar's [Ask agent to setup] button — replaces the API-key modal for
 * users on cooperative auditor mode (the new default).
 */
export const PROMPT_SETUP =
  `Please run AXME workspace setup for the current project. Do NOT shell out to ` +
  `\`axme-code setup\` — that runs background LLM calls billed separately. Instead, ` +
  `perform the setup cooperatively inside this chat using my Cursor subscription:\n\n` +
  `  1. Call axme_oracle with project_path=<workspace root> to scan top-level files ` +
  `and infer architecture facts. Repeat for each major subdirectory if the project ` +
  `is multi-package.\n` +
  `  2. For each architecture finding, call axme_save_decision (scope=workspace) with ` +
  `a clear rationale tied to evidence in the code.\n` +
  `  3. For each edge-case / gotcha you spot in the codebase, call axme_save_memory ` +
  `(type=pattern, scope=workspace) so future sessions don't repeat the surprise.\n` +
  `  4. For each dangerous command pattern or destructive operation present in the ` +
  `repo's scripts/, call axme_update_safety so the hooks block it.\n` +
  `  5. When done, give me a short summary: how many decisions/memories/safety rules ` +
  `you saved and what you skipped.\n\n` +
  `Stay focused on the SETUP. Don't open files unrelated to this scan. If you need ` +
  `permission to read large files, ask before doing it.`;

/**
 * Prompt that asks the agent to cleanly close the current session. NOT
 * surfaced by a sidebar button anymore (removed after user feedback that
 * the new-chat-spawn behaviour felt broken). Kept exported so a future
 * keybinding / palette command can drop this prompt with no extra work
 * — the agent already knows how to perform the flow via the MCP tools
 * axme_begin_close / axme_finalize_close.
 */
export const PROMPT_CLOSE_SESSION =
  `Please close this AXME session cleanly:\n\n` +
  `  1. Call axme_begin_close — it returns the close checklist.\n` +
  `  2. Follow the checklist: extract every memory / decision / safety rule that ` +
  `belongs in the knowledge base, picking the correct scope for each.\n` +
  `  3. Prepare handoff data: a 2-paragraph summary of what was accomplished and ` +
  `what's next, plus pointers to any in-progress branches / plans / open PRs.\n` +
  `  4. Call axme_finalize_close with everything from step 2 and 3.\n` +
  `  5. Output to me: storage summary (counts saved per type) followed by the ` +
  `startup_text the finalize call returns.\n\n` +
  `After this finishes, I'll open a new chat and AXME context will auto-load. The ` +
  `goal is zero context loss across the handoff — anything important from THIS chat ` +
  `must end up in .axme-code/ so the next chat sees it via axme_context.`;
