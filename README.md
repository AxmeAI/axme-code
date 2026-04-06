# AXME Code

**Persistent memory, decisions, and safety guardrails for Claude Code.**

[![Alpha](https://img.shields.io/badge/status-alpha-orange)]() [![npm](https://img.shields.io/npm/v/@axme/code)]() [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**[Quick Start](#quick-start)** · **[How It Works](#how-it-works)** · **[Architecture](docs/ARCHITECTURE.md)**

---

## The Problem

- **Agents forget everything between sessions** - your stack, conventions, past decisions, all gone
- **Agents can run dangerous commands** - `rm -rf`, `git push --force`, `npm publish` with no guardrails
- **No one tracks decisions** - why was this library chosen? what deploy procedure was agreed on?
- **You re-explain the same things every session** - "we use FastAPI, not Flask", "never push to main"
- **No continuity** - what was done yesterday? what's blocked? what's next?

AXME Code fixes all of this. You just work with Claude Code as usual - AXME Code handles the rest transparently.

---

## Quick Start

```bash
# Install globally
npm install -g @axme/code

# Initialize in your project (or workspace root for multi-repo)
cd your-project
axme-code setup

# That's it. Use Claude Code as usual:
claude
```

`axme-code setup` does three things:
1. Scans your project and builds the knowledge base (oracle, stack, structure)
2. Installs hooks for safety enforcement
3. Configures the MCP server in Claude Code settings

---

## What You Get

### Persistent Knowledge Base

Your agent starts every session with full context - project stack, architecture decisions, coding patterns, glossary, and what happened in the last session. No more "what framework do we use?" on session 47.

### Safety Guardrails (100% Reliable)

Safety rules are enforced by **hooks that intercept tool calls before execution** - not by prompts. Even if the agent hallucinates a reason to run `rm -rf /` or `git push --force origin main`, the hook blocks it. This is hard enforcement at the Claude Code harness level, not a suggestion in a system prompt.

### Automatic Knowledge Extraction

During work, the agent saves important discoveries (decisions, patterns, feedback) via MCP tools. At session close, a structured checklist ensures nothing is missed. And if you forget to close the session - a background auditor reads the transcript and extracts what the agent didn't save.

### Multi-Repo Workspaces

Each repo has its own knowledge base (`.axme-code/`). Workspace-level rules apply to all repos. Repo-specific rules stay scoped. The agent sees merged context - universal rules plus the repo it's working in.

---

## How It Works

![AXME Code Overview](docs/diagrams/axme-code-overview.png)

AXME Code has three components:

### 1. MCP Server (persistent, runs while VS Code is open)

Provides tools for the agent to read and write the knowledge base. All writes go through MCP server code (atomicWrite, correct append) - the agent never writes storage files directly. This guarantees format consistency.

### 2. Hooks (fire on every tool call)

**pre-tool-use**: Checks every Bash command, git operation, and file access against safety rules. Blocks violations before they execute. Also creates/recovers session tracking.

**post-tool-use**: Records which files the agent changed (for audit trail).

### 3. Background Auditor (runs after session close)

A detached process that reads the session transcript and catches anything the agent forgot to save. Two modes:
- **Full extraction** - when the agent crashed or the user closed the window without formal close
- **Verify-only** - when the agent completed the close checklist (lighter, cheaper)

### Session Flow

1. **Session starts** - agent calls `axme_context`, gets full knowledge base
2. **During work** - agent saves discoveries via `axme_save_memory`, `axme_save_decision`. Hooks enforce safety on every tool call.
3. **Session close** - user asks to close. Agent calls `axme_begin_close`, gets a checklist. Reviews the session for missed memories, decisions, safety rules. Checks for duplicates against loaded context. Calls `axme_finalize_close` with all data - MCP writes handoff, worklog, extractions atomically. Agent outputs storage summary and startup text for next session.
4. **Fallback** - if the user just closes the window, the auditor runs in background and extracts everything from the transcript.
5. **Next session** - `axme_context` returns everything accumulated. Handoff says where to continue.

> **Tip**: You can trigger saving at any time - just ask the agent "remember this" or "save this as a decision". You don't have to wait for session close.

---

## Storage

All data lives in `.axme-code/` in your project root (or workspace root for multi-repo):

```
.axme-code/
  oracle/           # stack.md, structure.md, patterns.md, glossary.md
  decisions/        # D-001-slug.md ... D-NNN-slug.md (with enforce levels)
  memory/
    feedback/       # Learned mistakes and corrections
    patterns/       # Validated successful approaches
  safety/
    rules.yaml      # git + bash + filesystem guardrails
  sessions/         # Per-session meta.json (tracking, agentClosed flag)
  plans/
    handoff.md      # Session handoff (Source: agent or auditor)
  worklog.jsonl     # Structured event log
  worklog.md        # Narrative session summaries
  config.yaml       # Model settings, presets
```

### Knowledge Categories

| Category | What it stores | Example |
|----------|---------------|---------|
| **Oracle** | Project structure, tech stack, coding patterns, glossary | "Python 3.11, FastAPI, PostgreSQL" |
| **Decisions** | Architectural decisions with enforcement levels (required/advisory) | "All deploys via GitHub Actions only" (required) |
| **Memory** | Feedback from mistakes, validated patterns | "Never use sync httpx in async handlers" |
| **Safety** | Protected branches, denied commands, filesystem restrictions | git push --force -> BLOCKED |
| **Handoff** | Where work stopped, blockers, next steps | "PR#17 open, needs review" |
| **Worklog** | Session history, audit results, events | Timeline of all sessions |

---

## Preset Bundles

During `axme-code setup`, preset bundles provide curated best-practice rules:

| Preset | What it adds |
|--------|-------------|
| **essential-safety** | Protected branches, no secrets in git, no force push, fail loudly |
| **ai-agent-guardrails** | Verification requirements, no autonomous deploys, proof before done |

---

## Development

```bash
npm install
npm run build       # esbuild -> dist/server.js + dist/cli.mjs
npm test            # Node.js test runner (requires Node 22+)
npx tsc --noEmit    # TypeScript strict type check
```

---

<details>
<summary><strong>Available MCP Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `axme_context` | Load full project knowledge base (oracle + decisions + safety + memory + plans + handoff) |
| `axme_oracle` | Show oracle data (stack, structure, patterns, glossary) |
| `axme_decisions` | List active decisions with enforce levels |
| `axme_save_decision` | Save a new architectural decision |
| `axme_save_memory` | Save feedback or pattern memory |
| `axme_search_memory` | Keyword search across memories |
| `axme_safety` | Show current safety rules |
| `axme_update_safety` | Add a new safety rule |
| `axme_status` | Project status (sessions, decisions count, last activity) |
| `axme_worklog` | Recent worklog events |
| `axme_workspace` | List all repos in workspace |
| `axme_begin_close` | Start session close - returns extraction checklist |
| `axme_finalize_close` | Finalize close - writes handoff, worklog, extractions atomically |
| `axme_ask_question` | Record a question only the user can answer |
| `axme_list_open_questions` | List open questions from previous sessions |
| `axme_answer_question` | Record the user's answer to an open question |

</details>

<details>
<summary><strong>CLI Commands</strong></summary>

```bash
axme-code setup [path]       # Initialize project/workspace KB with LLM scan
axme-code serve              # Start MCP server (called by Claude Code automatically)
axme-code status [path]      # Show project status (sessions, decisions, memories)
axme-code hook pre-tool-use  # PreToolUse hook handler (called by Claude Code)
axme-code hook post-tool-use # PostToolUse hook handler (called by Claude Code)
axme-code hook session-end   # SessionEnd hook handler (called by Claude Code)
axme-code audit-session      # Run LLM audit on a session transcript
```

</details>

---

## Related

| Repository | Description |
|-----------|-------------|
| [axme](https://github.com/AxmeAI/axme) | AXME platform - durable execution for AI agents |
| [axme-cli](https://github.com/AxmeAI/axme-cli) | Command-line interface |
| [axme-sdk-python](https://github.com/AxmeAI/axme-sdk-python) | Python SDK |
| [axme-sdk-typescript](https://github.com/AxmeAI/axme-sdk-typescript) | TypeScript SDK |
| [axme-docs](https://github.com/AxmeAI/axme-docs) | Documentation |

---

hello@axme.ai | [Security](SECURITY.md) | [License](LICENSE)
