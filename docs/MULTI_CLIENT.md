# Multi-Client Support

AXME Code is built as a [stdio MCP server](https://modelcontextprotocol.io/) — it works with **any MCP-compatible AI coding assistant**, not just Claude Code.

## Compatibility Matrix

| Client | MCP Tools | Safety Hooks | Session-end Auditor | File-change Tracking |
|--------|-----------|--------------|---------------------|----------------------|
| **Claude Code** (CLI / VS Code) | ✅ Full | ✅ Full | ✅ Automatic | ✅ Automatic |
| **Codex** (CLI / IDE extension) | ✅ Full | ✅ Full (`--ide=codex`) | ✅ Automatic¹ | ✅ Automatic |
| **Cursor** | ✅ Full | ❌ | ❌ | ❌ |
| **Windsurf** | ✅ Full | ❌ | ❌ | ❌ |
| **Cline** (VS Code) | ✅ Full | ❌ | ❌ | ❌ |
| **Claude Desktop** | ✅ Full | ❌ | ❌ | ❌ |
| **Any other MCP client** | ✅ Full | ❌ | ❌ | ❌ |

**MCP tools available everywhere** — the full set of 19 tools (`axme_context`, `axme_save_memory`, `axme_save_decision`, `axme_safety`, `axme_status`, etc.) works in any MCP client. Your agent can read and write the knowledge base.

**Hooks need a hook system** — pre-execution safety hooks, post-tool-use file tracking, and the session-end background auditor run on Claude Code and on Codex (whose hook protocol is Claude-Code-compatible). In other clients, the agent must explicitly call AXME tools (e.g., to save memories at session close).

¹ The background auditor still runs on the Claude Agent SDK, so it needs a `claude` login or `ANTHROPIC_API_KEY` even when the session itself ran in Codex. Codex's own transcript is not yet fed to the auditor; the audit sees the files changed, the worklog, and whatever the agent saved during the session.

## Quick Start (any client)

### 1. Install AXME Code

```bash
curl -fsSL https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.sh | bash
```

Installs to `~/.local/bin/axme-code`.

### 2. Initialize the project

```bash
cd your-project
axme-code setup
```

This builds the knowledge base (`.axme-code/`) and creates `.mcp.json` for Claude Code. **For other clients, copy the MCP server entry into your client's config** (see below).

### 3. Configure your client

The MCP server entry is identical for every client:

```json
{
  "command": "axme-code",
  "args": ["serve"]
}
```

Just place it in the right config file for your client.

---

## Per-Client Setup

### Claude Code

Already done by `axme-code setup` — `.mcp.json` is created in your project root. Just run `claude` and start using it.

### Codex (OpenAI)

Full support — MCP tools, safety hooks, file tracking and the session-end auditor:

```bash
cd your-project
axme-code setup --ide=codex
```

This writes three project-level files and leaves Claude Code's files alone:

- `.codex/config.toml` — `[mcp_servers.axme]` pointing at the installed binary (absolute path, so it also works when Codex is launched from the IDE extension or the desktop app).
- `.codex/hooks.json` — `SessionStart` (prints the "call axme_context" nudge as developer context), `PreToolUse` (safety + git gate), `PostToolUse` (file tracking from `apply_patch`), `SessionEnd` (spawns the detached auditor; Codex caps this hook at 3s, which is enough).
- `AGENTS.md` — the `## AXME Code` section (the CLAUDE.md analogue), including the `#!axme` commit/push gate rule.

Two Codex-specific notes:

- **Trust the project.** Codex loads a project's `.codex/` layer only for trusted projects. Accept the trust prompt the first time you run `codex` in the repo, or add `[projects."<absolute path>"]` with `trust_level = "trusted"` to `~/.codex/config.toml`.
- **Shell reads are policed.** Codex has no `Read` tool — every file read is a shell command — so the `PreToolUse` hook also blocks shell reads of denied paths (`cat ~/.ssh/id_rsa`, `/etc/shadow`, ...). Only absolute and `~`-relative deny patterns apply to the shell; bare basename patterns such as `.env` do not, so commit messages and heredocs that merely mention a file are not blocked.

The same `.axme-code/` knowledge base is shared with Claude Code, so you can switch between the two on one project.

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "axme": {
      "command": "axme-code",
      "args": ["serve"]
    }
  }
}
```

Restart Cursor. The agent will have access to all `axme_*` tools.

### Windsurf (Codeium)

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "axme": {
      "command": "axme-code",
      "args": ["serve"]
    }
  }
}
```

Restart Windsurf.

### Cline (VS Code extension)

Open VS Code Settings → search for "Cline MCP" → edit `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "axme": {
      "command": "axme-code",
      "args": ["serve"]
    }
  }
}
```

Reload the VS Code window.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or equivalent:

```json
{
  "mcpServers": {
    "axme": {
      "command": "axme-code",
      "args": ["serve"]
    }
  }
}
```

Restart Claude Desktop.

### Generic MCP Client

Any MCP client that supports stdio transport will work. The server is launched with:

```
axme-code serve
```

It reads from stdin and writes to stdout following the MCP JSON-RPC protocol.

---

## What You Get Without Hooks

In non-Claude-Code clients, you don't get automatic hook-based features. Workarounds:

### Safety enforcement
Hooks aren't available — the agent can still call `axme_safety` to check rules before running commands, but enforcement is advisory rather than blocking. **Recommendation**: rely on the agent's discipline, or wrap dangerous commands in a confirmation prompt at the application layer.

### Session-end audit
The background auditor doesn't trigger automatically. Instead, ask your agent to call `axme_begin_close` and `axme_finalize_close` at the end of work — the agent walks through the same checklist (memories, decisions, safety rules) and writes the handoff.

### File-change tracking
Without `PostToolUse` hooks, file changes aren't automatically logged. The agent can manually note significant changes in memories or via `axme_worklog`.

---

## Multiple Clients on the Same Project

You can use multiple clients on the same project — they all read and write to the same `.axme-code/` storage. Conflicts are unlikely because:
- All writes go through atomic file operations (`atomicWrite`)
- Session metadata is keyed by unique session IDs
- Append-only worklog handles concurrent sessions

The knowledge base is the single source of truth regardless of which client created an entry.

---

## Limitations

- **Hooks are not portable** — only Claude Code and Codex have a hook system AXME can plug into. Other clients will not get automatic safety blocking, file tracking, or session-end audits.
- **CLAUDE.md auto-injection** — only Claude Code reads `CLAUDE.md`; Codex reads `AGENTS.md` (written by `--ide=codex`). Other clients ignore both; you may need to provide instructions to your agent another way (e.g., a system prompt).
- **`.mcp.json` is Claude Code-specific** — `axme-code setup` writes this file, but other clients use different config locations (see above).
- **Session-to-session linking** — AXME tracks Claude Code's session IDs to link conversations across VS Code windows. Other clients don't expose session IDs the same way, so cross-window session linking may not work; sessions will still be tracked individually.

---

## Verifying It Works

After configuration, ask your agent in any client:

```
Call axme_context to load the project knowledge base.
```

If you see oracle, decisions, memories, and safety rules in the response — AXME is working.

---

## See Also

- [README](../README.md) — main documentation
- [ARCHITECTURE.md](ARCHITECTURE.md) — three-layer architecture
- [MCP Specification](https://modelcontextprotocol.io/) — protocol details
