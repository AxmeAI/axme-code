# AXME Code

MCP server plugin for Claude Code CLI. Provides persistent project knowledge, architectural decisions, memory, and safety rules.

## Quick Start

```bash
npm install -g @axme/code

# In your project:
axme-code setup

# Then use Claude Code as usual:
claude
```

## What It Does

AXME Code runs as an MCP (Model Context Protocol) server inside Claude Code. It gives Claude persistent memory about your project:

- **Oracle** - project structure, stack, patterns, glossary (auto-detected)
- **Decisions** - architectural decisions with enforcement levels
- **Memory** - learned feedback and successful patterns
- **Safety** - git, bash, and filesystem safety rules
- **Worklog** - session event log

## Available Tools

| Tool | Description |
|------|-------------|
| `axme_init` | Initialize project knowledge base |
| `axme_context` | Read full project context |
| `axme_oracle` | Show oracle data |
| `axme_decisions` | Show decisions |
| `axme_save_memory` | Save feedback or pattern |
| `axme_search_memory` | Search memories by keywords |
| `axme_save_decision` | Save architectural decision |
| `axme_update_safety` | Add safety rule |
| `axme_safety` | Show safety rules |
| `axme_status` | Project status |
| `axme_worklog` | Recent events |

## Preset Bundles

During initialization, preset bundles provide curated best-practice rules:

- **essential-safety** - git protection, no secrets, fail loudly
- **ai-agent-guardrails** - verification requirements, no autonomous deploys
- **production-ready** - staging-first, health checks, CI/CD only
- **team-collaboration** - conventional commits, PR size limits

## Storage

All data is stored in `.axme-code/` in your project root:

```
.axme-code/
  oracle/           stack.md, structure.md, patterns.md, glossary.md
  decisions/        D-001-slug.md, index.md
  memory/           feedback/*.md, patterns/*.md
  safety/           rules.yaml
  sessions/         <uuid>/meta.json
  config.yaml
  worklog.jsonl
```

## Development

```bash
npm install
npm run build
npm run lint        # TypeScript type check
```

## License

MIT
