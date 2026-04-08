# Contributing to AXME Code

Thanks for your interest in contributing! AXME Code is an MCP server plugin for Claude Code that provides persistent memory, decisions, and safety guardrails.

## Getting Started

### Prerequisites

- Node.js >= 20
- npm
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (for testing the full flow)

### Development Setup

```bash
git clone https://github.com/AxmeAI/axme-code.git
cd axme-code
npm install
npm run build
npm link          # makes `axme-code` available globally for testing
```

### Running Tests

```bash
npm test          # 413 tests, Node.js built-in test runner
npm run lint      # TypeScript type checking (tsc --noEmit)
npm run build     # esbuild bundle
```

All three must pass before submitting a PR.

## How to Contribute

### Bug Reports

Open an issue with:
- What you expected vs what happened
- Steps to reproduce
- Your environment (OS, Node version, Claude Code version)

### Feature Requests

Open an issue describing the use case. Focus on the problem you're solving, not the solution.

### Pull Requests

1. Fork the repo and create a branch: `feat/<topic>-<yyyymmdd>` or `fix/<topic>-<yyyymmdd>`
2. Make your changes
3. Run `npm test && npm run lint && npm run build`
4. Open a PR against `main`

Keep PRs focused — one feature or fix per PR. Under 400 lines is ideal.

## Project Structure

```
src/
  server.ts          # MCP server entry — registers all tools
  cli.ts             # CLI entry — setup, serve, status commands
  types.ts           # All shared types and constants
  tools/             # MCP tool implementations
  storage/           # Filesystem persistence layer (no LLM)
  agents/            # LLM sub-agents (scanners, auditor)
  hooks/             # Claude Code hook handlers
  utils/             # Shared utilities
test/                # Tests (Node.js built-in test runner)
docs/                # Architecture docs and diagrams
```

## Code Style

- TypeScript strict mode, ESM modules
- Functions: `camelCase`, verb-first (`saveMemory`, `loadOracleFiles`)
- Types: `PascalCase` (`SessionMeta`, `SafetyRules`)
- Files: `kebab-case.ts`
- Commit messages: [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`)

## Questions?

Open an issue or email hello@axme.ai.
