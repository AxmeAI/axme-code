1# AXME Code - Architecture

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

Launches as a stdio process when VS Code opens. Lives for the entire window lifetime. Provides Claude Code with tools:

| Tool | Purpose |
|------|---------|
| `axme_context` | Loads everything: oracle + decisions + safety + memory + plans + handoff. Called at session start. |
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
| `axme_begin_close` | Start session close: returns extraction checklist for the agent |
| `axme_finalize_close` | Finalize close: writes handoff, worklog, extractions, sets agentClosed flag |
| `axme_ask_question` | Record a question only the user can answer |
| `axme_list_open_questions` | List open questions from previous sessions |
| `axme_answer_question` | Record the user's answer to an open question |

**Key principle**: the MCP server is purely deterministic - no LLM inside. It acts as a database with a tool API. The agent asks, the server answers from `.axme-code/` storage. The agent learns something new, the server writes it to storage.

**Storage consistency**: all writes to `.axme-code/` go through MCP server code (atomicWrite, appendFileSync), never directly by the LLM. This guarantees correct file formats, proper append-to-end (not beginning), valid JSON in meta.json, and consistent YAML in rules.yaml. The agent provides data, the MCP server writes it correctly.

---

## 2. Hooks (pre/post tool use)

Fired by Claude Code automatically **on every tool call** (all tools, including MCP tools - no matcher restriction). Each invocation spawns a fresh `node dist/cli.mjs hook <name>` process.

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

### Two modes

The auditor operates in one of two modes based on the `agentClosed` flag in session meta:

**Full extraction mode** (`agentClosed=false` - crash/orphan sessions):
The agent didn't complete the close checklist. The auditor does full extraction using `AUDIT_PROMPT`.

**Verify-only mode** (`agentClosed=true` - agent closed the session):
The agent already extracted memories/decisions/safety via `axme_begin_close` + `axme_finalize_close`. The auditor uses `VERIFY_ONLY_AUDIT_PROMPT` - a lighter prompt that only catches items the agent missed. Most sections will be empty.

### What it does

1. Reads the Claude Code session transcript (`.jsonl` file, can be 10-20MB)
2. Uses resume offset - if part was already audited (after /compact), reads only new bytes
3. Renders transcript into XML format (not chat markers - otherwise the LLM confuses it with conversation continuation)
4. Sends to LLM with extraction prompt (full or verify-only):
   - **Memories** (feedback, patterns) - what the agent learned, what went wrong
   - **Decisions** - architectural decisions that were made
   - **Safety rules** - new restrictions (if discussed)
   - **Handoff** - where work stopped, what's next, blockers (skipped in verify-only if agent wrote it)
   - **Oracle changes** - whether stack/structure rescan is needed
   - **Session summary** - narrative for worklog.md (always generated)
5. For each extraction, performs **Grep dedup** - checks if it already exists in storage
6. Saves new/updated items to `.axme-code/` via scope routing (workspace-level or per-repo)
7. Does NOT overwrite agent handoff (if `source=agent` exists, auditor skips handoff write)
8. Writes audit log with full telemetry (cost, tokens, resume offsets, extractions)
9. Sets `auditStatus=done` on session meta

**Cost**: ~$0.05-0.15 per session (full mode), significantly less in verify-only mode.

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

### Session Close Flow (agent-driven)

When the user asks to close the session:

```
1. Agent calls axme_begin_close
   +-- MCP returns extraction checklist (what to extract, scope rules, dedup instructions)

2. Agent reviews the session
   +-- Compares candidates against axme_context data (already loaded)
   +-- For each item: checks for duplicates, contradictions, outdated entries
   +-- Saves memories/decisions/safety via existing tools (axme_save_*)
   +-- Prepares handoff, worklog entry, startup text

3. Agent calls axme_finalize_close (single call with everything)
   +-- MCP writes: handoff.md (atomicWrite), worklog.md (append), meta.json (agentClosed=true)
   +-- MCP executes: add/remove/supersede for memories, decisions, safety rules
   +-- MCP returns: storage summary (what was saved where)

4. Agent outputs to user: storage summary, then startup text
```

### Two-tier safety net

```
During session:                At session close:              After close (background):

  Agent works                   Agent calls begin_close       Auditor (LLM) reads transcript
       |                              |                              |
  Learns something              Gets checklist + dedup        Verify-only mode (agentClosed=true)
       |                              |                        or full extraction (crash/orphan)
       v                              v                              |
  Calls axme_save_*             Reviews session, extracts           v
       |                        Calls finalize_close          Catches what agent MISSED
       v                              |                              |
  MCP server writes                   v                              v
  to .axme-code/                MCP writes all files          .axme-code/ supplemented
                                atomically
```

The agent has full conversation context and produces higher-quality extractions than the auditor (which only sees the transcript, possibly truncated). The auditor is a safety net for:
- Crash/orphan sessions where the agent didn't complete the close checklist
- Items the agent missed even during explicit close

---

## Session Lifecycle

```
1. VS Code window opens
   +-- MCP server starts (axme-code serve)
   +-- Orphan scan: checks old sessions with dead pid -> spawns audit workers
   +-- Stale mapping adoption: if old mapping has dead ownerPpid, adopt it

2. Agent starts working
   +-- First tool call -> pre-tool-use hook -> ensureAxmeSessionForClaude
       -> creates AXME session in .axme-code/sessions/<id>/meta.json
       -> refreshes ownerPpid on reuse (handles VS Code reload)
       -> writes session_start to worklog

3. Agent calls axme_context
   +-- MCP server returns oracle + decisions + safety + memory + plans + handoff

4. Every tool call
   +-- pre-tool-use: safety check (block/allow) - fires on ALL tools (no matcher)
   +-- post-tool-use: track filesChanged (Edit/Write only)

5. Agent saves a decision/memory during work
   +-- axme_save_decision / axme_save_memory -> written to .axme-code/

6. User asks to close session
   +-- Agent calls axme_begin_close -> gets extraction checklist
   +-- Agent extracts memories/decisions/safety (with dedup against axme_context data)
   +-- Agent calls axme_finalize_close with all data
   +-- MCP writes: handoff.md, worklog.md, extractions, agentClosed=true
   +-- Agent outputs: storage summary + startup text to user

7. VS Code window closes (or stdin EOF)
   +-- cleanupAndExit -> spawn detached audit worker per owned session
   +-- Worker PID lives independently, VS Code is already dead

8. Detached auditor (20-60 sec)
   +-- agentClosed=true: verify-only mode (catch missed items only)
   +-- agentClosed=false: full extraction (crash/orphan)
   +-- Does NOT overwrite agent handoff (source=agent is authoritative)
   +-- Writes audit log, saves offset
   +-- auditStatus = done

9. Next session
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
|   |-- handoff.md       # What to pass to next session (Source: agent or auditor)
|   |-- handoff-<id>.md  # Versioned handoff per session (last 5 kept)
|   +-- <id>-<slug>.md   # Active plans with steps
|-- worklog.jsonl        # Append-only structured event log
|-- worklog.md           # Narrative session summaries (written by finalize_close + auditor)
+-- config.yaml          # Model settings, presets, review config
```

Each repo in a workspace has its own `.axme-code/` with separate decisions, oracle, and safety rules. The workspace-level `.axme-code/` stores cross-repo items and sessions.

---

## Two-Level Storage: Workspace vs Repo

### The Problem

A workspace can contain 50+ repos. Some knowledge is universal ("never push to main", "all SDKs release together"), some is repo-specific ("this repo uses Go 1.24", "httpx.AsyncClient is mandatory in gateway handlers"). Storing everything in one place either pollutes repo-specific context with irrelevant rules or loses cross-repo knowledge.

### The Solution: Two Storage Levels

```
axme-workspace/                         <- WORKSPACE ROOT
|-- .axme-code/                         <- WORKSPACE-LEVEL storage
|   |-- decisions/  (75 decisions)         cross-repo rules
|   |-- memory/     (feedback + patterns)  universal lessons
|   |-- safety/     (rules.yaml)           workspace-wide safety
|   |-- oracle/     (stack.md, ...)        workspace overview
|   |-- sessions/   (session tracking)     ALL sessions live here
|   +-- worklog.jsonl                      ALL events live here
|
|-- axme-control-plane/
|   +-- .axme-code/                     <- REPO-LEVEL storage
|       |-- decisions/  (60 decisions)     repo-specific rules
|       |-- memory/                        repo-specific lessons
|       |-- safety/     (rules.yaml)       repo-specific safety
|       +-- oracle/     (stack.md, ...)    repo tech stack
|
|-- axme-cli/
|   +-- .axme-code/                     <- REPO-LEVEL storage
|       |-- decisions/  (46 decisions)
|       |-- ...
|
|-- axme-sdk-python/
|   +-- .axme-code/                     <- REPO-LEVEL storage
|       +-- ...
|
+-- ... (56 repos total, each with .axme-code/)
```

### What Lives Where

| Level | What gets stored | Example |
|-------|-----------------|---------|
| **Workspace** | Cross-repo rules, universal conventions, session tracking, worklog, audit logs, plans, handoff | "All SDKs release together on same version", "Never merge PRs as agent", "Protected branches: main" |
| **Repo** | Repo-specific tech stack, coding patterns, architecture decisions, repo-specific safety rules | "Python SDK uses httpx (sync only)", "Go CLI uses Cobra", "axme-control-plane: AsyncClient mandatory in async handlers" |

### Scope Routing: How Writes Go to the Right Place

Every item (decision, memory, safety rule) has an optional `scope` field that controls where it gets stored. Routing happens identically for saves during a session (via MCP tools) and saves after a session (via the auditor).

```
scope: undefined / [] / ["all"]
  -> writes to workspace root .axme-code/
     (discoverable by all repos via merged context)

scope: ["axme-control-plane"]
  -> writes to axme-control-plane/.axme-code/
     (only visible when working in that repo)

scope: ["axme-cli", "axme-sdk-go"]
  -> writes to BOTH repos' .axme-code/
     (visible in either repo, not in others)
```

The routing logic in code (`saveScopedDecisions`, `saveScopedMemories`, `saveScopedSafetyRule`):

```typescript
if (isAllScope) {
  // scope=all -> write to session origin (workspace root in workspace sessions)
  save(projectPath, item);
} else {
  // scope=["repo-a", "repo-b"] -> write to each listed repo
  for (const repoName of scope) {
    const repoPath = join(workspacePath, repoName);
    save(repoPath, item);
    crossProject++;
  }
}
```

D-NNN IDs are generated independently per storage location. Workspace root and each repo have their own sequence: workspace D-075, axme-control-plane D-060, axme-cli D-046 - these are all independent counters.

### Merge on Read: How Both Levels Combine

When the agent calls `axme_context`, both levels are read and merged into a single unified view. The merge strategy differs by data type:

**Decisions** - concatenate, project wins on ID conflict:
```
workspace decisions:  D-001..D-075 (universal rules)
  +
repo decisions:       D-001..D-060 (repo-specific)
  =
agent sees:           135 decisions total
```
If workspace has D-042 and repo has D-042 (same ID, different content), the repo version wins. In practice this doesn't happen because IDs are generated independently and slugs differ.

**Safety rules** - union merge, strictest wins:
```
workspace rules.yaml:                    repo rules.yaml:
  protectedBranches: [main, master]        protectedBranches: [main, develop]
  deniedPrefixes: [rm -rf /, ...]          deniedPrefixes: [docker push, ...]
  allowForcePush: false                    allowForcePush: false

merged result:
  protectedBranches: [main, master, develop]    <- union
  deniedPrefixes: [rm -rf /, ..., docker push]  <- union
  allowForcePush: false                         <- AND (both must allow)
  requirePrForMain: true                        <- OR (either can require)
```

Principle: deny lists **union** (a deny at any level wins), boolean allow flags **AND** (both levels must allow), boolean require flags **OR** (either level can require).

**Memories** - concatenate, deduplicate by slug (repo wins):
```
workspace memories:  universal feedback + patterns
  +
repo memories:       repo-specific feedback
  =
agent sees:          combined set, repo version wins on slug collision
```

**Oracle** - both levels returned, labeled separately:
```
Workspace oracle:  overall workspace structure, project list
Project oracle:    repo-specific stack, patterns, glossary
```
The agent sees both sections in `axme_context` output, clearly labeled as "Workspace Context" and "Project Context".

### Per-Repo Gate

Before working in any specific repo, the agent must call `axme_context` with that repo's path. This loads the repo-level context on top of the workspace context. Without this call, the agent only sees workspace-level rules and misses repo-specific decisions and patterns.

This is enforced by instruction in CLAUDE.md:
```
### Per-Repo Gate (MANDATORY)
Every repo has its own .axme-code/ storage created during setup.
BEFORE reading code, making changes, or running tests in any repo:
  call axme_context with that repo's path to load repo-specific context.
```

### Auditor Scope Routing

The post-session auditor decides scope for each extraction based on the transcript content. If the agent discussed a Python-specific pattern while working in `axme-control-plane`, the auditor routes it to that repo. If the agent discussed a universal rule ("never merge PRs"), the auditor routes it to workspace level.

The auditor also uses `filesChanged` from the session to infer which repos were touched, and routes extracted items accordingly. A memory about a bug in `axme-cli/cmd/axme/tasks.go` goes to `axme-cli/.axme-code/`, not to the workspace root.

### Why Not Just One Level?

With 56 repos and 2444+ decisions, a flat storage would be unusable:
- The agent would see all 2444 decisions on every `axme_context` call, most irrelevant
- Safety rules for a Go CLI repo would include Python-specific rules from the gateway
- Oracle would mix TypeScript patterns with Java conventions

Two levels give the agent **focused context**: only the universal rules plus the repo it's actually working in.
