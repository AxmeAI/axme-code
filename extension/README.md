<p align="center">
  <img src="https://raw.githubusercontent.com/AxmeAI/axme-code/main/extension/media/icon.png" width="160" height="160" alt="AXME Code logo" />
</p>

# AXME Code

Persistent memory, decisions, and safety guardrails for AI coding agents — Cursor, GitHub Copilot, Cline, Continue, Roo Code, Windsurf, and any VS Code chat agent that respects the Language Model API.

## What this extension does

- Registers `axme-code` as an MCP server so the agent has access to the project knowledge base — `axme_context`, `axme_save_memory`, `axme_save_decision`, `axme_safety`, and ~15 more tools.
- Installs safety hooks at the user level (`~/.cursor/hooks.json`) so dangerous operations (force-push to main, `rm -rf` on protected paths, secret-file edits) are blocked **before** the agent runs them.
- **AXME sidebar (Activity Bar)** — always-visible monitor with live counters for memories / decisions / safety / backlog, an audit-mode toggle, a backlog list, and a current-session block (tokens / age / messages). Click the AXME icon in the Activity Bar.
- **Auditor with three modes** — `cooperative` (default for Cursor: agent saves inline via MCP tools, no extra cost), `background` (detached LLM after each chat, requires its own API key), or `off`. Switch any time from the sidebar dropdown.
- **Cooperative close** — one-click "Close session (handoff)" prompt that walks the agent through `axme_begin_close` → checklist → `axme_finalize_close`, preserving everything important from the chat in `.axme-code/` for the next session.

## Requirements

- Cursor 0.42+ **or** VS Code 1.96+ (Copilot Agent Mode, Cline, Continue, Roo Code, Windsurf — anything that consumes MCP servers via the standard discovery API).
- The `axme-code` CLI installed on your `$PATH`. Get it: `curl -fsSL https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.sh | bash`. The extension auto-detects it on activation; if your install is non-standard, set `axme.binaryPath` in settings.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `axme.binaryPath` | `""` | Absolute path to the `axme-code` binary. Leave empty for auto-detect. |
| `axme.contextMode` | `"full"` | `full` loads every memory into agent context. `search` uses semantic search at scale. |
| `axme.enableHooks` | `true` | Register safety hooks. Turn off if you don't want machine-wide guardrails. |
| `axme.auditorMode` | `"cooperative"` | Auditor extraction mode. `cooperative` (no extra cost, agent saves inline), `background` (detached LLM after each chat, uses its own API key), or `off`. |

## Commands

- **AXME: Set up workspace** — runs `axme-code setup` against the current workspace folder (background mode; uses your API key).
- **AXME: Open dashboard** — opens the worklog / decisions / memories view.
- **AXME: Reindex semantic search** — rebuilds the embeddings index.
- **AXME: Show status** — webview healthcheck (binary / MCP / hooks / auth / KB per workspace).
- **AXME: Reauth auditor** — paste / change the credential used by background-mode auditor.
- **AXME: Reset** — clear AXME entries from `~/.cursor/hooks.json` and reset auth state on this machine (workspaces untouched).

The sidebar exposes additional one-click flows: **Ask agent to setup** (cooperative setup prompt), **Close session (handoff)**, **+ Add backlog item**, **Reinstall hooks**.

## How this differs from the CLI install

The `axme-code` CLI alone writes `.cursor/mcp.json` and `.cursor/hooks.json` per project. Cursor 0.42+ requires a manual **Enable** click in Settings → MCP for any new project-level server (security feature). This extension registers MCP via Cursor's extension API directly, bypassing the per-project Enable gate — install the extension once, every project just works.

## Platform support (v0.0.3)

| Platform | Bundled CLI | Setup + MCP + hooks | Sidebar UI | Notes |
| --- | --- | --- | --- | --- |
| **macOS arm64** (Apple Silicon) | ✅ verified | ✅ verified | ✅ verified | Primary dev/test platform; full UI verification done |
| **Linux x64** | ✅ verified | ✅ verified | ⚠️ binary verified, full UI not yet sampled | CI matrix runs the 608-test core suite + binary self-test on every push |
| **Linux arm64** | ✅ CI builds | ✅ via CI runner | ❌ not verified | First-class target via Open VSX matrix publish |
| **Windows x64** | ✅ verified headlessly (Azure VM) | ✅ verified — setup wrote oracle/decisions/memories/safety, hooks.json correct | ❌ real Cursor UI not yet verified | See "Windows notes" below |
| **macOS x64** (Intel) | ⚠️ CI builds | ⚠️ untested | ❌ untested | Apple discontinuing Intel; ship best-effort |
| **Windows arm64** | ⚠️ no CI runner yet | ❌ untested | ❌ untested | GitHub Actions free tier lacks this runner as of 2026 |

### Windows notes

The bundled `axme-code` binary inside the `.vsix` is a shebang shim — text starting with `#!/usr/bin/env node` followed by a CJS payload. POSIX (Linux/macOS) honours the shebang and executes it directly. **Windows ignores shebangs**, so the binary is always invoked via `node` on Windows — both internally (extension's spawnBinary helper) and in the generated `~/.cursor/hooks.json` commands.

**Requirement on Windows**: `node` must be on the user's PATH. The vast majority of Windows Cursor users have Node installed for dev work; if you don't, install from <https://nodejs.org> first.

### macOS notes

The bundled binary is **not signed** for the Apple Developer ecosystem in v0.0.3. On a fresh macOS install Gatekeeper may block the first execution with "axme-code can't be opened because Apple cannot check it for malicious software". Two fixes:

- One-off: `xattr -d com.apple.quarantine /path/to/axme-code` then retry.
- System-wide: System Preferences → Privacy & Security → "Allow Anyway" after the first blocked launch.

Signed binaries are on the v0.1.0+ roadmap once we have $99/year Apple Developer ID enrolment.

## License

MIT — see [LICENSE](https://github.com/AxmeAI/axme-code/blob/main/LICENSE).
