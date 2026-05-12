# Set up the workspace

Setup scans your repo and bootstraps the AXME knowledge base in `.axme-code/`:

- **`oracle/`** — high-level architecture facts the agent should treat as ground truth.
- **`decisions/`** — explicit choices like "we use ESM modules" or "all DB calls go through repository pattern".
- **`memory/feedback/`** + **`memory/patterns/`** — gotchas, edge cases, things that surprised someone once.
- **`safety/rules.yaml`** — commands and file paths the hooks should block (e.g. `git push --force`, edits to `~/.aws/credentials`).
- **`backlog/`** — open work that persists across chat sessions.

## Recommended path — ask the agent (no extra cost)

1. In the AXME sidebar (or this walkthrough page), click **Copy setup prompt → paste in chat**.
2. A short toast confirms the prompt was copied to your clipboard.
3. Open or focus a Cursor chat with **Cmd / Ctrl + L**.
4. Paste with **Cmd / Ctrl + V** and hit **Enter**.

The agent calls AXME MCP tools (`axme_oracle`, `axme_save_decision`,
`axme_save_memory`, `axme_update_safety`) directly inside the chat. Everything
runs on your **Cursor subscription** — no separate API key, no extra billing.
The sidebar counters tick up live as files appear in `.axme-code/`.

This is the path that step 2 of the walkthrough completes on. Once the agent
finishes, the **Set up the workspace** step gets checked off automatically.

## Alternative — API key path

If you'd rather not occupy your chat with a setup pass, click
**Run setup with API key** in step 2. AXME prompts you (modal) for an
Anthropic or Cursor SDK API key, saves it to `~/.config/axme-code/`, and
spawns the scanners as a separate process.

Cost: a few cents per setup depending on repo size — billed against the API
key you paste in, not your Cursor subscription.

## Re-running setup

Setup is idempotent. You can re-run it any time later from the sidebar
"Workspace not initialised" section, the command palette `AXME: Set up
workspace`, or by asking the agent in chat.
