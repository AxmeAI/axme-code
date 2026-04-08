---
title: "How I Fixed Claude Code's Amnesia (Actually)"
published: false
description: "Claude Code forgets your project every session. CLAUDE.md helps, but it doesn't scale. I built an MCP server plugin that gives Claude Code persistent memory, decisions, and safety guardrails."
tags: claude, ai, devtools, productivity
cover_image:
canonical_url:
---

Every Claude Code session starts the same way: "We use TypeScript with ESM modules. Deploy only via GitHub Actions. Never push to main directly. Here's our architecture..." You've had this conversation forty times. The agent nods, does great work, and then forgets everything by tomorrow.

I got tired of re-explaining my project on session 47. So I built something to fix it.

## The Problem

Claude Code has no persistent memory between sessions. Every conversation starts from zero. Here's what that actually looks like after a few weeks of real use:

**Decisions evaporate.** Session 12: you decide to use Zod for validation instead of Joi. Session 13: the agent generates Joi code. You correct it. Session 14: Joi again.

**The same mistakes repeat.** You discover `httpx.Client` (sync) in async handlers blocks the event loop. You tell the agent. Next session, it writes `httpx.Client` inside `async def`. Again.

**Safety rules are just suggestions.** You say "never push to main directly." Three sessions later, the agent hallucinates a reason why this push is fine and runs `git push origin main`.

**Context gets lost at the worst time.** Session 31 ended mid-refactor. The agent doesn't know where you stopped. You spend 15 minutes of session 32 catching up.

## Why CLAUDE.md Alone Doesn't Work

The standard answer is "put it in CLAUDE.md." I tried. Everyone tries.

CLAUDE.md works when your project is simple and you have ten lines of instructions. It doesn't scale.

After a month, your CLAUDE.md has 200 lines. Some decisions contradict each other because you changed your mind. There's no structure, no enforcement levels, no way to distinguish "strict safety rule" from "mild preference." The important parts are buried under noise.

Worse, CLAUDE.md has no enforcement. You can write "NEVER run git push --force" in all caps, and the agent will still do it if it hallucinates a justification. A prompt is a suggestion, not a guardrail.

And CLAUDE.md has no memory. It can't learn from corrections or remember last session. Every piece of context it contains, you put there by hand.

## What I Built

[AXME Code](https://github.com/AxmeAI/axme-code) is an MCP server plugin for Claude Code. It runs transparently in the background and gives your agent five things it doesn't have natively:

**Oracle** -- a project knowledge base. Your tech stack, directory structure, coding patterns, glossary. Generated automatically by scanning your codebase at setup, updated as the project evolves.

**Decisions** -- architectural decisions with enforcement levels. Each decision is `required`, `advisory`, or informational. "All deploys via CI/CD only" is `required`. "Use conventional commits" is `advisory`. The agent sees the enforcement level and treats them differently.

**Memory** -- two types. *Feedback* is error patterns to avoid: "never use sync HTTP in async handlers." *Patterns* is validated approaches to reuse: "chunked audit for transcripts over 150K tokens." The agent learns from corrections and successful approaches, and that knowledge persists.

**Safety guardrails** -- hard enforcement via Claude Code hooks, not prompts. Protected branches, denied commands (`rm -rf /`, `npm publish`, `curl | sh`), denied file paths (`.env`, `.ssh/`, credentials). Hooks intercept the command *before execution* and block it. The agent cannot bypass this by hallucinating a justification.

**Handoff** -- session continuity. When a session ends, the agent writes a structured handoff: what it did, where it stopped, what PRs are open, what's next. The next session picks up exactly where the last one left off.

## How It Works

Four steps. The first two are one-time setup.

### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.sh | bash
```

### 2. Setup your project

```bash
cd your-project
axme-code setup
```

This scans your codebase with LLM agents (runs in about 30 seconds), builds the knowledge base, installs safety hooks, and configures the MCP server in `.mcp.json`. If you don't have an API key, it falls back to deterministic detection -- no LLM required for basic functionality.

### 3. Use Claude Code as usual

```bash
claude
```

That's it. The agent calls `axme_context` at session start and gets everything: oracle, decisions, memories, safety rules, and the handoff from the previous session. You don't change your workflow. You don't call special commands. The MCP tools are available if you want to explicitly tell the agent "remember this" or "save this as a decision," but the system works passively too.

### 4. Next session

The agent already knows your project. It has the handoff from yesterday. It knows the decisions you made in session 12. It remembers the mistake from session 7. Safety hooks are active from the first tool call.

All data lives in `.axme-code/` in your project root. Human-readable markdown and YAML files. No database, no external service, no account required. The directory is gitignored automatically -- your knowledge base stays local.

```
.axme-code/
  oracle/        # stack.md, structure.md, patterns.md, glossary.md
  decisions/     # D-001-slug.md with enforce levels
  memory/
    feedback/    # Learned mistakes
    patterns/    # Validated approaches
  safety/
    rules.yaml   # git + bash + filesystem guardrails
  sessions/      # Per-session tracking
  plans/
    handoff-*.md # Session continuity (last 5 kept)
```

## Safety That Actually Works

This is the part I care about most.

There's a fundamental difference between a prompt and a hook. A prompt says "please don't do this." A hook says "you cannot do this."

When Claude Code uses a tool -- Bash, Write, Edit, anything -- a `PreToolUse` hook fires *before* the tool executes. AXME Code's hook checks every command against the safety rules: protected branches, denied command prefixes, denied file paths.

Here's what happens when the agent tries to force push:

```
Agent: I'll push these changes to main.
> git push --force origin main

[AXME Safety] Force push is not allowed.
[AXME Safety] Direct push to main is not allowed.
```

The command never executes. The agent gets an error message and has to find another way. It doesn't matter *why* the agent decided to force push. It doesn't matter how convincing its reasoning was. The hook doesn't read the reasoning. It reads the command.

This is the difference between "the agent usually follows the rules" and "the agent cannot break the rules." Prompt-based safety depends on the model's compliance. Hook-based safety depends on string matching against a YAML file. One of these is reliable.

By default, AXME Code blocks: force pushes, direct pushes to main/master/develop, `rm -rf /`, `chmod 777`, `curl | sh`, `npm publish`, `git tag`, `gh release create`, and writes to sensitive file paths like `.env`, `.ssh/`, and credential files.

## Real Results

I've been using AXME Code as the primary development tool for building AXME Code itself (yes, it's recursive). Here are the real numbers from my workspace:

- **180+ sessions** tracked with full metadata
- **100+ decisions** accumulated in the main repo alone (across the workspace: 2,400+, though many are duplicates from early iterations before dedup was solid)
- **60+ memories** (feedback and patterns) across the workspace
- **90 safety rules** active (allowed prefixes, denied commands, protected paths)
- **30 dangerous commands blocked** -- including `git push origin main`, `git push --force`, `rm -rf /`, `npm publish`
- **413 tests** passing across 88 suites

The handoff system is what made the biggest practical difference. Before AXME Code, starting a new session on an ongoing project meant 10-15 minutes of re-orientation. Now the agent reads the handoff, sees "stopped at: PR #47 merged, PR #48 open for review, next step: fix flaky lock test," and picks up immediately.

The decisions log turned out to be more useful than I expected. Not just for the agent -- for me. Having a structured record of every architectural decision with the reasoning attached is something I should have been doing manually all along.

## Try It

AXME Code is open source (MIT), alpha quality, and actively developed.

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.sh | bash

# Setup in your project
cd your-project
axme-code setup

# Use Claude Code normally
claude
```

What to expect: setup takes about 30 seconds (with LLM scanning) or 2 seconds (deterministic fallback). After that, every Claude Code session starts with full project context. You'll see `axme_context` in the tool calls at session start. Safety hooks are active immediately.

What not to expect: this is alpha software. The auditor sometimes extracts duplicate memories. The knowledge base needs occasional cleanup. Multi-repo workspace support works but has edge cases. I'm fixing these in the open.

GitHub: [github.com/AxmeAI/axme-code](https://github.com/AxmeAI/axme-code)

If you've been frustrated with Claude Code forgetting your project every session, give it a try. The install is one command, the setup is one command, and you can always `rm -rf .axme-code/` to go back to the way things were. (AXME Code won't block that one -- it's your project.)
