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

When you're done (or when the session-block warning fires near 200k tokens),
just ask the agent in the chat: **"close the session"** (any language). The
agent calls `axme_begin_close`, walks the checklist, then `axme_finalize_close`
— and gives you a one-line summary plus a startup prompt for the next chat.
Memories and decisions are saved to `.axme-code/`, so the new chat picks them
up via `axme_context` automatically. Zero context lost.
