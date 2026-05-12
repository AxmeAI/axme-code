# Set up the workspace

Setup scans your repo and bootstraps the AXME knowledge base in `.axme-code/`:

- **`oracle/`** — high-level architecture facts the agent should treat as ground truth.
- **`decisions/`** — explicit choices like "we use ESM modules" or "all DB calls go through repository pattern".
- **`memory/feedback/`** + **`memory/patterns/`** — gotchas, edge cases, things that surprised someone once.
- **`safety/rules.yaml`** — commands and file paths the hooks should block (e.g. `git push --force`, edits to `~/.aws/credentials`).
- **`backlog/`** — open work that persists across chat sessions.

## Two ways to run setup

### Cooperative (recommended — no extra cost)

Click **Ask agent to set up** in step 2. We copy a setup prompt to your clipboard
and open a fresh chat tab. Paste, hit enter, and the agent does the scan inside
the chat using your Cursor subscription. Nothing else is billed.

### Background (one-time fee, more thorough)

Click **Set up with API key**. You'll be asked for an Anthropic or Cursor SDK
API key (saved to `~/.config/axme-code/`). The scan then runs as a separate
LLM process, more methodical but billed separately. Good for very large repos
or when you want to do it once and forget about it.

Either way, this step completes when `.axme-code/` is created. You can also
re-run setup any time from the sidebar or `AXME: Set up workspace` command.
