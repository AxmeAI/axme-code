# AXME Code — Claude Code Plugin

> **Alpha** — This plugin is in active development. Expect breaking changes between versions. [Report issues](https://github.com/AxmeAI/axme-code/issues).

Persistent memory, architectural decisions, and safety guardrails for Claude Code. Your agent starts every session with full project context — stack, decisions, patterns, safety rules, and a handoff from the previous session.

[![Alpha](https://img.shields.io/badge/status-alpha-orange)]()
[![Version](https://img.shields.io/badge/version-0.5.0-blue)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**[Main Repository](https://github.com/AxmeAI/axme-code)** · **[Website](https://code.axme.ai)** · **[Issues](https://github.com/AxmeAI/axme-code/issues)**

---

## What It Does

Claude Code forgets your project every session. AXME Code fixes that.

- **Persistent Knowledge Base** — oracle (stack, structure, patterns, glossary), architectural decisions with enforcement levels, accumulated memories from past sessions
- **Safety Guardrails** — hooks intercept dangerous commands *before* execution (not prompts — hard enforcement at the harness level). Blocks `git push --force`, `rm -rf /`, `npm publish`, direct commits to `main`, and more
- **Session Continuity** — handoff system tells the next session exactly where work stopped, what's in progress, and what to do next
- **Automatic Learning** — background auditor extracts memories, decisions, and safety rules from session transcripts when you close the window
- **19 MCP Tools** — `axme_context`, `axme_save_decision`, `axme_save_memory`, `axme_safety`, `axme_backlog`, and more

You keep using Claude Code exactly as before. AXME Code works transparently in the background.

## Install

From terminal:
```bash
claude plugin install axme-code
```

From Claude Code interactive CLI:
```
/plugin install axme-code
```

## First Use

After installing the plugin, open any project in Claude Code. On the first session:

1. The plugin creates a `CLAUDE.md` section that instructs the agent to call `axme_context`
2. The agent will say the project is not initialized and run `axme-code setup --plugin`
3. Setup scans your project (uses an LLM to analyze your stack, extract decisions, detect safety patterns) and creates the `.axme-code/` knowledge base
4. From the next session onward, the agent automatically loads the full knowledge base

**Setup requires a Claude subscription** (the LLM scan uses Claude Sonnet). If the scan fails, a deterministic fallback creates a minimal knowledge base from file system inspection.

## How It Works

### Hooks (automatic, transparent)

| Hook | When | What |
|------|------|------|
| **SessionStart** | Session opens | Installs SDK dependency, creates CLAUDE.md if missing |
| **PreToolUse** | Before every tool call | Checks safety rules, blocks violations |
| **PostToolUse** | After Edit/Write | Tracks which files changed |
| **SessionEnd** | Session closes | Spawns background auditor to extract knowledge |

### MCP Server

Provides 19 tools for reading and writing the knowledge base. The agent calls these tools naturally during work — no manual intervention needed.

### Storage

All data lives in `.axme-code/` in your project root (gitignored automatically):

```
.axme-code/
  oracle/           # stack.md, structure.md, patterns.md, glossary.md
  decisions/        # Architectural decisions with enforce levels
  memory/           # Learned mistakes (feedback/) and validated patterns (patterns/)
  safety/rules.yaml # git + bash + filesystem guardrails
  backlog/          # Persistent cross-session task tracking
  sessions/         # Session metadata
  plans/            # Handoff files for session continuity
  worklog.jsonl     # Structured event log
```

Human-readable markdown and YAML. No database, no external dependencies.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (CLI or VS Code extension)
- Node.js >= 20
- Claude subscription (for LLM-powered setup and session auditor)

## Alpha Status

This is alpha software (v0.x.y). What that means:

- **Breaking changes** may happen in minor version bumps (0.x.0 -> 0.x+1.0)
- **Storage format** may change between versions (`.axme-code/` is local and gitignored, so upgrades won't affect your repo)
- **Bug reports are welcome** — [open an issue](https://github.com/AxmeAI/axme-code/issues)
- **Feedback** — we're actively iterating based on user feedback. Tell us what works and what doesn't

## Auto-Sync

This repo is auto-synced from the main [axme-code](https://github.com/AxmeAI/axme-code) repository on each release. **Do not edit files here directly** — changes will be overwritten.

## License

[MIT](LICENSE)

---

[Website](https://code.axme.ai) · [Main Repo](https://github.com/AxmeAI/axme-code) · [Issues](https://github.com/AxmeAI/axme-code/issues) · contact@axme.ai
