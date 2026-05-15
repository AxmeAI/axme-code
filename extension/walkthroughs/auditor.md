# Pick your auditor mode

The session auditor extracts new memories / decisions / safety rules from your chat
transcripts so the knowledge base keeps growing without you having to think about it.

## Cooperative — **default for Cursor**

The agent saves important findings **inline during the chat** using MCP tools like
`axme_save_memory`, `axme_save_decision`, `axme_update_safety`. No separate LLM is
spawned at chat end — everything happens on your Cursor subscription. Most thorough
*per saved item* (the agent has full context when saving), least automatic
(it only saves what the agent thinks is important in the moment).

Cost: **$0 beyond your Cursor subscription.**

## Background

After every chat ends, a detached audit worker reads the full transcript and runs
its own LLM extraction. More exhaustive — catches stuff the agent forgot to save
inline. Requires its own credential:

- Anthropic API key (pay-per-token via console.anthropic.com)
- Cursor SDK key (uses your Cursor account billing — Pro users have included quota)

Cost: **a few cents per chat depending on transcript length.**

## Where to change

Either the sidebar dropdown in the **AXME** Activity Bar view, or VS Code
settings → search for `axme.auditorMode`. This step completes the moment you change
the setting at all.
