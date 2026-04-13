# Multi-Client Support

AXME Code is built as a [stdio MCP server](https://modelcontextprotocol.io/) — it works with **any MCP-compatible AI coding assistant**, not just Claude Code.

## Compatibility Matrix

| Client | MCP Tools | Safety Hooks | Session-end Auditor | File-change Tracking |
|--------|-----------|--------------|---------------------|----------------------|
| **Claude Code** (CLI / VS Code) | ✅ Full | ✅ Full | ✅ Automatic | ✅ Automatic |
| **Cursor** | ✅ Full | ❌ | ❌ | ❌ |
| **Windsurf** | ✅ Full | ❌ | ❌ | ❌ |
| **Cline** (VS Code) | ✅ Full | ❌ | ❌ | ❌ |
| **Claude Desktop** | ✅ Full | ❌ | ❌ | ❌ |
| **Any other MCP client** | ✅ Full | ❌ | ❌ | ❌ |

**MCP tools available everywhere** — the full set of 19 tools (`axme_context`, `axme_save_memory`, `axme_save_decision`, `axme_safety`, `axme_status`, etc.) works in any MCP client. Your agent can read and write the knowledge base.

**Hooks are Claude Code-only** — pre-execution safety hooks, post-tool-use file tracking, and the session-end background auditor depend on Claude Code's hook system. In other clients, the agent must explicitly call AXME tools (e.g., to save memories at session close).

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

- **Hooks are not portable** — Claude Code's hook system is unique. Other clients will not get automatic safety blocking, file tracking, or session-end audits.
- **CLAUDE.md auto-injection** — only Claude Code reads `CLAUDE.md`. Other clients ignore it; you may need to provide instructions to your agent another way (e.g., a system prompt).
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
