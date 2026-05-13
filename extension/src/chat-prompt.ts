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
 *
 * IMPORTANT — this prompt is intentionally imperative. Earlier drafts said
 * "Call axme_save_decision for each finding" and Cursor models would
 * narrate "Save decision: X / Save decision: Y" as text without actually
 * invoking the tool — classic plan-instead-of-act failure. The fix is to
 * (a) put EXECUTE in caps, (b) explicitly name the failure mode and tell
 * the agent it has failed if it does that, and (c) demand minimum tool-
 * call counts so the agent can't say "I did one and that's enough".
 */
export const PROMPT_SETUP =
  `Run AXME workspace setup for the CURRENT project. This is a sequence ` +
  `of MCP TOOL CALLS, NOT a plan to describe in prose.\n\n` +
  `Forbidden: do NOT shell out to \`axme-code setup\` (it bills separately).\n` +
  `Forbidden: do NOT list "Save decision: X / Save memory: Y" as text — ` +
  `those words are TOOL CALLS, perform them via the MCP tool, do not narrate ` +
  `them. If you catch yourself enumerating saves in prose, STOP and call the ` +
  `tool instead. Bullet-listing is a FAILURE of this task.\n\n` +
  `Steps:\n\n` +
  `1. Scan the repo: read top-level files (package.json, README, configs) and ` +
  `the main source folders to understand stack, conventions, file layout. ` +
  `You may use axme_oracle, Read, Glob, or Grep — whichever is fastest.\n\n` +
  `2. EXECUTE at least 5 axme_save_decision calls — one per architecture ` +
  `fact (framework, build system, routing convention, important file ` +
  `layout choice, deployment target, etc). Use scope=["workspace"]. Each ` +
  `decision needs a concrete title and a rationale tied to evidence you ` +
  `read in the repo.\n\n` +
  `3. EXECUTE at least 3 axme_save_memory calls — one per gotcha / edge ` +
  `case / non-obvious thing future sessions should remember (e.g. "Tailwind ` +
  `v4 has no tailwind.config.js", "site URL hardcoded in two places"). ` +
  `Use type="pattern", scope=["workspace"].\n\n` +
  `4. EXECUTE axme_update_safety for each dangerous pattern in scripts/ ` +
  `or top-level config — destructive commands, paths that must never be ` +
  `edited, branches that must never be force-pushed.\n\n` +
  `4b. EXECUTE 4 axme_save_oracle calls — one per section:\n` +
  `   - section="stack": markdown listing languages, frameworks, build tools, ` +
  `package manager, runtime versions (read package.json / pyproject.toml / ` +
  `go.mod / Cargo.toml — whichever apply).\n` +
  `   - section="structure": markdown listing top-level dirs with one-line ` +
  `purpose for each, plus entry points.\n` +
  `   - section="patterns": markdown describing observed coding patterns / ` +
  `conventions (ESM vs CJS, file-based vs convention routing, where tests ` +
  `live, etc).\n` +
  `   - section="glossary": markdown defining 3–5 project-specific terms ` +
  `you spotted in code or README (e.g. "Oracle = ...", "Handoff = ...").\n` +
  `Each section gets one call with mode="replace" (default). Oracle is the ` +
  `high-level project overview future sessions read at startup.\n\n` +
  `5. ONLY after all tool calls are committed, output a structured summary:\n` +
  `   - First line: "Saved X decisions, Y memories, Z safety rules + N preset ` +
  `rules" where N is the count of enforcement entries (deniedPrefixes + ` +
  `deniedCommands + protectedBranches + deniedPaths + readOnlyPaths) that ` +
  `were ALREADY in .axme-code/safety/rules.yaml when you started (not ` +
  `added by you this session). Read the file to count them accurately.\n` +
  `   - Then list the PRESET rules grouped by section. Format:\n` +
  `       deniedPrefixes:\n` +
  `         - rm -rf /\n` +
  `         - git push --force\n` +
  `         ...\n` +
  `       deniedCommands:\n` +
  `         - shutdown\n` +
  `         ...\n` +
  `       protectedBranches: main, master, develop\n` +
  `       deniedPaths:\n` +
  `         - ~/.ssh/id_*\n` +
  `         ...\n` +
  `       readOnlyPaths:\n` +
  `         ...\n` +
  `   - Final note to the user (verbatim): "These presets ship with AXME ` +
  `Code. You can edit \`.axme-code/safety/rules.yaml\` directly to add ` +
  `project-specific rules or remove ones you don't need."\n\n` +
  `The .axme-code/ directory does not need to exist beforehand — the save ` +
  `tools bootstrap it on first call. If a tool returns an error, retry once ` +
  `with corrected arguments, then move to the next. Stay focused on setup, ` +
  `do not open files unrelated to this scan.`;

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
