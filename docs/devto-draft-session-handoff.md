---
title: "How I stopped Claude Code from force-pushing to main"
published: false
description: "Lessons in AI agent safety — why system prompts aren't enough, and how pre-execution hooks give you actually reliable guardrails."
tags: claudecode, ai, llm, devops
cover_image: https://code.axme.ai/og-image.png
canonical_url: https://code.axme.ai/safety/
---

Last Friday I watched my Claude Code agent go to run `git push --force origin main` on a repo with five other contributors. It had an explicit instruction in `CLAUDE.md` not to do that. It did it anyway because a long conversation context nudged it down that path, and the system prompt rule never fired at the critical moment.

Nothing bad happened — I aborted the command at the confirmation. But I spent the weekend thinking about why this keeps happening, and what a real fix looks like.

## System prompts are a suggestion, not a guardrail

Every time you put safety rules in a system prompt or `CLAUDE.md`, you're asking the model to remember them and follow them across an arbitrary number of turns. This works **most** of the time. The failure modes:

- Long sessions where the rule falls out of the effective attention window
- Adversarial or unusual user prompts that frame the dangerous action as "the right thing to do"
- Tool-use chains where the agent reasons itself into a corner and concludes the rule doesn't apply here
- Fresh sessions that never re-read your CLAUDE.md section on safety

If you want a rule that **always** holds, you can't rely on the model to hold it. You need enforcement at a layer the model can't bypass.

## Claude Code's hook system gives you that layer

Claude Code exposes a hook system that intercepts tool calls **before** the model's `tool_use` resolves into an actual shell command. You register a command for `PreToolUse`, Claude Code invokes it with the tool name and input as JSON on stdin, and if your command exits with a "deny" verdict, the tool call never happens. The model sees the denial as a tool result, but the destructive action is blocked at the harness level — it couldn't happen even if the model decided to ignore every rule in your system prompt.

Here's a minimal deny hook for `git push --force`:

```javascript
#!/usr/bin/env node
// pre-tool-use.js — reject dangerous bash commands before they execute.
const input = JSON.parse(require("fs").readFileSync(0, "utf-8"));
if (input.tool_name === "Bash") {
  const cmd = input.tool_input.command ?? "";
  if (/^\s*git\s+push\s+.*--force/.test(cmd)) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Denied: `git push --force` is not allowed on this repo",
      },
    }));
    process.exit(0);
  }
}
```

Register it in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "node /path/to/pre-tool-use.js",
        "timeout": 5
      }]
    }]
  }
}
```

The next time the agent tries to force-push, the command dies at the harness layer with a reason the agent can read back. It can't retry its way around it — the decision was made by code, not by another prompt.

## Beyond safety: architectural decisions deserve the same treatment

Once you have pre-execution enforcement wired up, you start seeing other things that should live there:

- **Architectural decisions**: "All deploys go through CI, not `gcloud run deploy` locally." Enforce it as a deny on the bash prefix, not as a sentence in CLAUDE.md.
- **Branch protection**: "Never push directly to main." Deny at hook level.
- **Secret handling**: "Do not `cat` files matching `.env*` or `*.pem`." Deny via filesystem rule.
- **Release flow**: "No `npm publish`, `git tag`, `gh release create` from agent sessions — humans only." Deny list.

All of these are rules you can (and probably do) write in CLAUDE.md today. They'll mostly work. But when they need to hold 100% of the time, "mostly" isn't enough.

## Session handoff is the other half of the problem

Safety hooks stop bad actions. But the agent also **forgets everything it learned between sessions** — which is a different class of failure. Decisions you explained yesterday ("we chose Postgres over MongoDB because…") have to be re-explained tomorrow. Bugs the agent fixed and understood at 3pm Wednesday are mystery code at 9am Thursday. The context doesn't persist; the rationale doesn't persist; the memory of what worked and what didn't doesn't persist.

What I wanted was a structured knowledge base that the agent could reload at every session start — not a free-form memory dump, but a categorized one: an **oracle** describing the stack and structure, a list of **decisions** with enforcement levels (required / advisory), **memories** separating what worked from what didn't, and **safety rules** loaded as hooks automatically. Plus a **handoff**: a short note from the last session saying where I stopped, what was broken, and what to do next.

## I built this, it's called axme-code

After that Friday I started building the thing I wanted. It ships as a Claude Code plugin and gives your agent, on every session:

- A categorized knowledge base (oracle, decisions, memories, safety)
- Pre-execution safety hooks at the Claude Code harness level (so the guardrails actually fire)
- Session handoff from the previous session
- A background auditor that extracts new memories, decisions, and safety rules from the transcript when you close the session

Install via the Claude Code plugin system:

```
/plugin marketplace add anthropics/claude-plugins-community
/plugin install axme-code@claude-community
```

Or standalone CLI: `curl -fsSL https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.sh | bash`, then `axme-code setup` in any project.

Website: [code.axme.ai](https://code.axme.ai) — explains how memory, decisions, and safety layers work together.  
Source: [github.com/AxmeAI/axme-code](https://github.com/AxmeAI/axme-code) — MIT, still alpha, actively developed.

## What I'd love from you

If you're running Claude Code on a real codebase, this is the kind of project that only gets better with real-world edge cases. Install it, break it, open an issue. The failure mode I described above is the kind of thing I want to make structurally impossible — not just improbable.

And if you've built similar guardrails in your own setup: what's your experience? Has the hook system held up where system prompts failed for you, or have you hit cases where hooks also aren't enough?
