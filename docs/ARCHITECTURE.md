# AXME Code - Architecture

## Overview

AXME Code is an MCP server plugin for Claude Code. Its purpose is to **accumulate and serve project knowledge across sessions**. Without it, every new Claude Code session starts from zero - the agent knows nothing about the stack, decisions, or rules. With it, the agent receives full context at session start: "this project uses Python + FastAPI, here are 60 architectural decisions, here are the safety rules, here is what happened in the last session".

## Three Layers

```
+---------------------------------------------+
|  MCP Server (persistent, stdio)             |  <- lives as long as VS Code window is open
|  11 tools: axme_context, axme_decisions,    |
|  axme_save_memory, axme_oracle, ...         |
+---------------------------------------------+
|  Hooks (pre-tool-use, post-tool-use,        |  <- fire on EVERY Claude Code tool call,
|  session-end)                               |     fresh process each time
+---------------------------------------------+
|  Detached Auditor (post-session)            |  <- LLM analysis of transcript after
|  axme-code audit-session                    |     window close
+---------------------------------------------+
```

---

## 1. MCP Server (`axme-code serve`)

Launches as a stdio process when VS Code opens. Lives for the entire window lifetime. Provides Claude Code with 11 tools:

| Tool | Purpose |
|------|---------|
| `axme_context` | Loads everything: oracle (stack, structure, patterns, glossary) + active decisions + safety rules + memory + plans. Called at session start. |
| `axme_decisions` | List active decisions with enforce levels |
| `axme_save_decision` | Agent saves a new architectural decision (with slug-based dedup) |
| `axme_save_memory` | Agent saves feedback/pattern (mistakes, approaches) |
| `axme_search_memory` | Keyword search across memories |
| `axme_oracle` | Stack + structure + patterns + glossary |
| `axme_safety` | Current safety rules (git, bash, filesystem) |
| `axme_update_safety` | Add a new safety rule |
| `axme_status` | Project status (sessions, decisions count, etc.) |
| `axme_worklog` | Event log (session starts, audit results) |
| `axme_workspace` | List all repos in workspace |

**Key principle**: the MCP server is purely deterministic - no LLM inside. It acts as a database with a tool API. The agent asks, the server answers from `.axme-code/` storage. The agent learns something new, the server writes it to storage.

---

## 2. Hooks (pre/post tool use)

Fired by Claude Code automatically **on every tool call** (Edit, Write, Bash, Read...). Each invocation spawns a fresh `node dist/cli.mjs hook <name>` process.

### `pre-tool-use` - BEFORE tool execution

- **Safety enforcement**: checks `checkGit` (push to main? force push?), `checkBash` (rm -rf /? npm publish?), `checkFilePath` (/etc/passwd? .env?)
- If violation detected: returns `"deny"` and Claude Code blocks the tool call
- If OK: silently passes
- Also calls `ensureAxmeSessionForClaude` - lazily creates an AXME session on the first hook call of the window

### `post-tool-use` - AFTER tool execution

- Only fires for `Edit | Write | NotebookEdit`
- Records the changed file path into `session.filesChanged[]`
- This is the only real-time mechanism for tracking what the agent modified (Bash mutations are supplemented later during audit via transcript parsing)

### `session-end` - when Claude Code session closes

- Sets `closedAt` on the session meta
- Runs `runSessionCleanup` which spawns a detached audit worker

---

## 3. Detached Auditor (post-session LLM)

A **separate process** (`axme-code audit-session --workspace X --session Y`), spawned via `child_process.spawn({ detached: true })` + `child.unref()`. Has its own process group (setsid), so it survives VS Code close, MCP server kill, Claude Code kill.

### What it does

1. Reads the Claude Code session transcript (`.jsonl` file, can be 10-20MB)
2. Uses resume offset - if part was already audited (after /compact), reads only new bytes
3. Renders transcript into XML format (not chat markers - otherwise the LLM confuses it with conversation continuation)
4. Sends to LLM (Sonnet) with a prompt to extract:
   - **Memories** (feedback, patterns) - what the agent learned, what went wrong
   - **Decisions** - architectural decisions that were made
   - **Safety rules** - new restrictions (if discussed)
   - **Handoff** - where work stopped, what's next, blockers
   - **Oracle changes** - whether stack/structure rescan is needed
5. For each extraction, performs **Grep dedup** - checks if it already exists in storage
6. Saves new/updated items to `.axme-code/` via scope routing (workspace-level or per-repo)
7. Writes audit log with full telemetry (cost, tokens, resume offsets, extractions)
8. Updates handoff.md (for the next session)
9. Sets `auditStatus=done` on session meta

**Cost**: ~$0.05-0.15 per session (Sonnet), depends on transcript length.

---

## Who Writes to Storage?

There are **two writers**, at different times:

### Writer 1: The Agent (Claude Code) - writes DURING the session

When the agent makes a decision or learns something important during work, it calls an MCP tool directly:
- `axme_save_decision` - "we decided to use Valkey instead of Redis"
- `axme_save_memory` - "this bug was caused by sync httpx in async handler"
- `axme_update_safety` - "add npm publish to denied"

The MCP server accepts the call and writes a file to disk. No LLM involved.

### Writer 2: The Auditor (LLM) - writes AFTER the session closes

Reads the full transcript and extracts what the agent **forgot** to save. The agent may have discussed an important decision with the user but never called `axme_save_decision`. The auditor catches this.

### How the agent knows to save

Three levels of instruction reach the agent:

1. **CLAUDE.md** (in workspace root, auto-loaded by Claude Code):
   ```
   ### During Work
   - Save memories/decisions/safety rules immediately when discovered
   ```

2. **MCP server `instructions`** (injected into system prompt on connect):
   ```
   Save memories, decisions, and safety rules immediately
   when discovered during work.
   ```

3. **Tool descriptions** (visible in the agent's tool list):
   - `axme_save_decision` - "Save a new architectural decision. Use enforce='required' for rules that must be followed..."
   - `axme_save_memory` - "Save a feedback or pattern memory. Use 'feedback' for learned mistakes..."

### Two-tier safety net

```
During session:                After session:

  Agent works                   Auditor (LLM) reads transcript
       |                              |
  Learns something important   Finds things agent discussed
       |                        but did NOT save
       v                              |
  Calls axme_save_*                   v
       |                        Saves via the same
       v                        storage modules
  MCP server writes                   |
  to .axme-code/                      v
                                .axme-code/ supplemented
```

In practice, the agent saves **some** items - usually what the user explicitly asks for ("remember this"). The auditor catches **the rest** - decisions made during discussion, error patterns, safety rules implied by context but never formally recorded.

The auditor is a safety net. Without it, the knowledge base depends entirely on how disciplined the agent is about calling save tools.

---

## Session Lifecycle

```
1. VS Code window opens
   +-- MCP server starts (axme-code serve)
   +-- Orphan scan: checks old sessions with dead pid -> spawns audit workers

2. Agent starts working
   +-- First tool call -> pre-tool-use hook -> ensureAxmeSessionForClaude
       -> creates AXME session in .axme-code/sessions/<id>/meta.json
       -> writes session_start to worklog

3. Agent calls axme_context
   +-- MCP server returns oracle + decisions + safety + memory + plans

4. Every tool call
   +-- pre-tool-use: safety check (block/allow)
   +-- post-tool-use: track filesChanged (Edit/Write only)

5. Agent saves a decision/memory
   +-- axme_save_decision / axme_save_memory -> written to .axme-code/

6. VS Code window closes
   +-- session-end hook -> closedAt -> spawn detached worker
   +-- Worker PID lives independently, VS Code is already dead

7. Detached auditor (20-60 sec)
   +-- Reads transcript -> LLM extraction -> dedup -> save
   +-- Writes audit log, updates handoff, saves offset
   +-- auditStatus = done

8. Next session
   +-- axme_context picks up everything accumulated
```

---

## Storage Layout

```
.axme-code/
|-- oracle/              # stack.md, structure.md, patterns.md, glossary.md
|-- decisions/           # D-001-*.md ... D-075-*.md (YAML frontmatter)
|-- memory/
|   |-- feedback/        # Mistakes and corrections
|   +-- patterns/        # Successful approaches
|-- safety/
|   +-- rules.yaml       # git + bash + filesystem rules
|-- sessions/            # Per-session meta.json
|-- active-sessions/     # Claude session -> AXME session mapping
|-- audited-offsets/     # Resume byte offsets per transcript
|-- audit-logs/          # Per-audit telemetry JSON
|-- audit-worker-logs/   # Worker stderr output
|-- plans/
|   |-- handoff.md       # What to pass to next session
|   +-- active/          # Current plans
+-- worklog.jsonl        # Append-only event log
```

Each repo in a workspace has its own `.axme-code/` with separate decisions, oracle, and safety rules. The workspace-level `.axme-code/` stores cross-repo items and sessions.
