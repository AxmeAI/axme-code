# AXME Code

Persistent memory, decisions, and safety guardrails for AI coding agents — Cursor, GitHub Copilot, Cline, Continue, Roo Code, Windsurf, and any VS Code chat agent that respects the Language Model API.

## What this extension does

- Registers `axme-code` as an MCP server so the agent has access to the project knowledge base — `axme_context`, `axme_save_memory`, `axme_save_decision`, `axme_safety`, and ~15 more tools.
- Installs safety hooks at the user level (`~/.cursor/hooks.json`) so dangerous operations (force-push to main, `rm -rf` on protected paths, secret-file edits) are blocked **before** the agent runs them.
- Auto-spawns the session auditor at chat end — extracts non-obvious patterns / decisions / safety rules from your conversation and saves them to `.axme-code/` for the next session to load.

## Requirements

- Cursor 0.42+ **or** VS Code 1.96+ (Copilot Agent Mode, Cline, Continue, Roo Code, Windsurf — anything that consumes MCP servers via the standard discovery API).
- The `axme-code` CLI installed on your `$PATH`. Get it: `curl -fsSL https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.sh | bash`. The extension auto-detects it on activation; if your install is non-standard, set `axme.binaryPath` in settings.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `axme.binaryPath` | `""` | Absolute path to the `axme-code` binary. Leave empty for auto-detect. |
| `axme.contextMode` | `"full"` | `full` loads every memory into agent context. `search` uses semantic search at scale. |
| `axme.enableHooks` | `true` | Register safety hooks. Turn off if you don't want machine-wide guardrails. |

## Commands

- **AXME: Set up workspace** — runs `axme-code setup` against the current workspace folder.
- **AXME: Open dashboard** — opens the worklog / decisions / memories view.
- **AXME: Reindex semantic search** — rebuilds the embeddings index.
- **AXME: Show status** — shows session count, audit health, recent worklog entries.

## How this differs from the CLI install

The `axme-code` CLI alone writes `.cursor/mcp.json` and `.cursor/hooks.json` per project. Cursor 0.42+ requires a manual **Enable** click in Settings → MCP for any new project-level server (security feature). This extension registers MCP via Cursor's extension API directly, bypassing the per-project Enable gate — install the extension once, every project just works.

## License

MIT — see [LICENSE](https://github.com/AxmeAI/axme-code/blob/main/LICENSE).
