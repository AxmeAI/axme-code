# Open your first AXME-aware chat

You're ready. Open a fresh chat (`Cmd/Ctrl + L` in Cursor) and the agent will:

1. **See AXME tools in its toolbox** — `axme_context`, `axme_save_memory`,
   `axme_save_decision`, `axme_safety`, `axme_oracle`, `axme_backlog`, and ~15 more.
2. **Auto-load context at startup** — the agent calls `axme_context` on its first
   turn, pulling in all decisions / memories / safety rules / active backlog items.
3. **Have hard safety guardrails** — try asking the agent to run
   `git push --force origin main` or edit `~/.aws/credentials`. The hook fires
   *before* the command executes and blocks it with `[AXME Safety] BLOCKED`.

## Watch the sidebar

While the chat runs, the AXME sidebar shows live activity:

- **Memories / decisions / safety counters** tick up as the agent saves things.
- **Current session** block reports tokens / messages / age. A warning banner
  appears around 200 000 tokens — that's roughly where Cursor's own auto-summarize
  fires, and where you should click **Close session** to handoff cleanly to a
  fresh chat without losing context.

## Closing cleanly

When you're done (or when the session-block warning fires near the 50-message
mark or after ~2h), just ask the agent in the chat: **"close the session"**
(any language). The agent calls `axme_begin_close`, walks the checklist,
then `axme_finalize_close` — and gives you a one-line summary plus a startup
prompt for the next chat. Memories and decisions are saved to `.axme-code/`,
so the new chat picks them up via `axme_context` automatically. Zero context
lost.

The close also writes a **handoff** file at `.axme-code/plans/handoff-*.md`
summarizing what was accomplished and what's next. The AXME sidebar's Status
section shows when the most recent handoff happened; you can also open it
from Command Palette → "AXME: Show last handoff".

## Safety presets

AXME ships ~40 enforcement rules out of the box — denied bash prefixes
(`git push --force`, `rm -rf /`, `chmod 777`, secret-file edits…), protected
branches (`main`, `master`, `develop`), denied paths (`~/.ssh/id_*`,
`~/.aws/credentials`, `*.pem`, `*.key`, etc). The hooks block these *before*
the command runs. The sidebar's "Safety rules" counter shows the total; click
the row to open `.axme-code/safety/rules.yaml` directly — you can add
project-specific rules or remove ones you don't need.

## Other things in the sidebar

- **Backlog** — persistent tasks across sessions. `[+ Add item]` for quick
  capture, click any row to open the .md.
- **Open questions** — things the agent flagged for human decision
  (`axme_ask_question` MCP tool). Click to open the file, answer inline.
- **Status block** — appears only when something needs attention (pending
  background audits, last audit failed, or a recent handoff). Otherwise
  hidden.

## Semantic search (opt-in)

By default, AXME loads every memory + decision body into the agent's context
at session start (**full mode**). Works great until your knowledge base grows
past ~50 entries — then context bloat becomes a problem.

**Semantic search mode** loads only the catalog (slug + title + 1-line
description) at startup and exposes `axme_search_kb` so the agent fetches
relevant bodies on demand. Saves significant tokens on large KBs.

Enable from the sidebar's **Knowledge base** section (`Search mode: full →
[Enable]` button) or via `AXME: Enable semantic search` command. The first
enable downloads `@huggingface/transformers` (~770 MB) into
`~/.local/share/axme-code/runtime/` and indexes every existing memory +
decision. Subsequent re-enables are instant.

Disable any time with the sidebar toggle or `AXME: Disable semantic search`.
The runtime and the embeddings index stay on disk — re-enabling is fast.

## Power-user palette commands

`Cmd+Shift+P → AXME:`
- **Self-test** — verify the binary + hooks + MCP server boot.
- **Audit knowledge base** — review all memories/decisions for staleness,
  contradictions, low-signal entries. Writes a report to
  `.axme-code/kb-audit/`.
- **Show stats** — local usage telemetry.
- **Clean up orphaned session state** — remove mappings whose Cursor
  process is dead.
- **Show last handoff / worklog / audit log / test plan / deploy checklist /
  files changed** — direct access to every `.axme-code/` artifact.
