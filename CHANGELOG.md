# Changelog

## [0.2.8] - 2026-04-14

### Fixed
- **Audit worker crash on every session close** (B-006): bundled CJS build called the Claude Agent SDK without an explicit `pathToClaudeCodeExecutable`. The SDK resolves its own binary via `import.meta.url`, which is `undefined` in CJS, so it crashed inside `fileURLToPath()` with `TypeError [ERR_INVALID_ARG_TYPE]`. The D-121 fix had landed in `buildAgentQueryOptions()` but `runSingleAuditCall`, `formatAuditResult` and `runMemoryExtraction` built their SDK options by hand and bypassed the helper. Result on v0.2.7: 14+ consecutive `audit_complete=failed` events in telemetry, auto-extraction effectively dead. Fix exports `findClaudePath()` from `src/utils/agent-options.ts` and sets `pathToClaudeCodeExecutable` on all three direct call sites. Smoke-tested on a real failed session: `auditStatus` flipped from `failed` to `done`, full LLM round-trip, no crash. (#105)
- **`#!axme` safety gate falsely blocked commits when the marker was placed inside `-m "..."` quotes** (B-008): regex `\bpr=(\S+)` and `\brepo=(\S+)` greedily captured the closing quote of the surrounding commit message, producing malformed `gh pr view --repo "OWNER/REPO\""` calls that `gh` rejected. The hook then fail-closed with `Cannot verify PR #N status (gh CLI error)` on every retry. Fix tightens the value capture to forbid quote/backtick characters, defensively strips trailing `)`, `]`, `,`, `;`, `.`, and updates the gate instruction to remind agents that the marker belongs **after** the closing quote. (#107)

### Added
- **Extended `classifyError` vocabulary** (B-007): added bounded slugs `node_invalid_arg`, `module_not_found`, `spawn_error`, `out_of_memory`, plus generic `type_error` / `reference_error` fallbacks via `err.name`. Match order is load-bearing: specific Node `ERR_*` codes are checked before generic JS error kinds so B-006-class failures keep their triage signal instead of collapsing into `unknown`. Network catches now also include `econnreset`. (#106)
- **`audit_complete` failures now stamp `category: "audit"` and `fatal: false`** so they land in the backend's `(category, error_class)` composite index. Previously every failed audit had `category=NULL`, making the admin "Top error classes" panel useless for triage — all 16 prod failures over the last 30 days collapsed into a single opaque bucket. (#106)

### Tests
- 14 new unit tests covering the three fixes (5 in `test/axme-gate.test.ts` for the regex regression, 6 in `test/telemetry.test.ts` for the new error classes, 3 in `test/agent-sdk-paths.test.ts` static guard against any future `sdk.query()` site that forgets `pathToClaudeCodeExecutable`).
- Total test count: 475 → 489.

## [0.2.7] - 2026-04-10

### Added
- **Anonymous telemetry client** (`src/telemetry.ts`): Phase 1 lifecycle events (`install`, `startup`, `update`) and Phase 2 product-health events (`audit_complete`, `setup_complete`, `error`). Sends to AXME control plane at `https://api.cloud.axme.ai/v1/telemetry/events`. (#97)
- **Opt-out via environment**: `AXME_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` (industry standard) fully disables — no machine ID generated, no network calls, no persistent state. Documented in README. (#97)
- **Anonymous machine ID**: 64-char random hex at `~/.local/share/axme-code/machine-id` (mode 0600), not derived from hardware. Regenerated on file corruption. (#97)
- **Offline queue**: Failed sends append to `telemetry-queue.jsonl` (cap 100, oldest dropped), flushed on next successful send. (#97)
- **Bounded error vocabulary** (`classifyError`): maps caught exceptions to one of 12 slugs (`prompt_too_long`, `oauth_missing`, `network_error`, `parse_error`, etc.) — never sends raw exception messages. (#97)
- **Session close feedback request**: After `axme_finalize_close`, agent shows feedback request to user (GitHub stars, issues, hello@axme.ai). (#96)
- **Two-phase auditor**: Replaces single-call audit with free-text analysis (`runSingleAuditCall`) + structured formatting via second SDK call. Eliminates parser-drop-everything failures on long transcripts. (#96)
- **`droppedCount` field** in `parseAuditOutput`: counts blocks the parser dropped due to missing required fields, surfaced in `audit_complete` telemetry as early-warning for format drift. (#96, #97)
- **15 unit tests for JSON audit parser** + **48 unit tests for telemetry module** (mid generation, opt-out, queue, classifyError, payload shapes, ci detection). Total test count: 412 → 475. (#96, #97)

### Fixed
- **`axme_finalize_close` did not spawn auditor**: pre-existing bug. The MCP tool only set `agentClosed=true` and returned, leaving the audit to run only when SessionEnd hook fired (often killed by VS Code) or MCP server eventually exited. Now spawns `spawnDetachedAuditWorker` directly so audits run in verify-only mode immediately. (#96)
- **`auditStatus` missing from `meta.json` after finalize_close**: same root cause as above. The detached worker now claims `pending` state itself in `runSessionCleanup` (avoids self-dedup race). (#96)
- **`axme_status` arithmetic did not sum to total**: 6 decisions with `enforce=null` were not counted in either Required/Advisory line. Added `Other:` line so the three sum to total. (#96)
- **`axme_update_safety` did not emit worklog event**: `memory_saved` and `decision_saved` were logged but `safety_updated` was not. Added `logSafetyUpdated` helper, `safety_updated` to `WorklogEventType`, threaded `sessionId` through MCP handler into `updateSafetyTool`. (#96)
- **`setup_complete` payload missing `scanners_run`/`scanners_failed`**: spec required both. Added counters to `InitResult`, threaded through `cli.ts` setup handler. (#97)
- **`mcp_tool` error category not wired**: `reportError("mcp_tool", ...)` was reserved in the bounded enum but no call site existed. Wrapped `server.tool()` once with monkey-patch so all 19 registered tool handlers auto-fire `error` event with `category=mcp_tool`, `fatal=true` on throw. (#97)
- **`.mcp.json` formatting normalized** to match `setup` command output (multiline arrays via `JSON.stringify(obj, null, 2)`) so re-running setup leaves no stale diff. (#96)
- **Plugin README install commands**: replaced `--plugin-dir` (per-session only) with the real install paths (`claude plugin install` from terminal, `/plugin install` from interactive CLI). (#96)

### Changed
- **`sendStartupEvents` is now `await`-able and uses blocking sends**: under event-loop pressure (parallel LLM scanners), fire-and-forget `setImmediate` callbacks could stall and cause fetch timeouts → false-fail → offline queue → server-side duplicates. Awaiting startup sends sequentially before heavy work begins eliminates this. (#97)
- **Telemetry network timeout** raised from 5s to 30s: prevents false-fail under heavy load. (#97)
- **Subprocess telemetry suppression**: `buildAgentQueryOptions` and session-auditor sub SDK queries now inject `AXME_TELEMETRY_DISABLED=1` into child env, so spawned `claude-agent-sdk` subprocesses that re-launch axme-code as MCP server don't fire extra startup events. (#97)
- **CLI startup events restricted to user-facing commands** (`setup`, `status`, `stats`, `audit-kb`, `cleanup`, `help`). `hook` and `audit-session` subcommands run as short-lived subprocesses many times per session and would spam the endpoint. The `serve` subcommand sends its own startup event from `server.ts` after MCP boot. (#97)

## [0.2.0] - 2026-04-07

### Added
- **Context pagination**: MCP tool outputs split into pages (25K char limit) to prevent truncation. Affects `axme_context`, `axme_oracle`, `axme_decisions`, `axme_memories`. (#36)
- **Auto-update**: Binary installs check GitHub releases on MCP server startup, download and replace automatically. 24h cache. Notification in `axme_context`. (#37)
- **#!axme commit/push gate**: Every `git commit` and `git push` must include `#!axme pr=<number|none> repo=<owner/repo>` suffix. Hook verifies PR is not merged. Fail-closed on errors. (#38, #39)
- **Tag/publish block**: `git tag`, `npm publish`, `twine upload`, `dotnet nuget push`, `mvn deploy`, `gh release create` blocked by safety hooks. Agent provides commands to user instead. (#41)
- **Session close verification checklist**: Structured close flow with extraction checklist. (#34)
- **144 tests**: Comprehensive test suite covering safety gate, bash safety, audit dedup, pagination, auto-update.

### Fixed
- **Duplicate sessions on reload**: Filesystem lock (O_EXCL) prevents parallel hooks from creating multiple AXME sessions per Claude session. (#40)
- **Duplicate audit workers**: `cleanupAndExit` deduplicates by Claude session ID before spawning. Cross-session concurrent-audit check as defense-in-depth. (#40)
- **Stuck audit logs**: `finally` block ensures audit log finalized. SIGTERM/SIGINT handlers in audit worker. (#40)
- **Safety hook cwd bug**: Old `checkMergedBranch` ran `gh` without correct cwd, failing silently. Replaced entirely by #!axme gate. (#38)
- **Install script unbound variable**: Fixed bash strict mode error on exit. (#22)
- **Dependabot vulnerability**: Patched @anthropic-ai/sdk (GHSA-5474-4w2j-mq4c). (#22)

### Changed
- **Binary-only distribution**: Removed npm publish workflow. Install via `curl | bash` only. (#37)
- **Compact KB format**: Save prompts produce self-contained descriptions. Compact `showDecisions` one-line format. (#26)
- **Context split**: `axme_context` returns compact meta + instructions to load oracle/decisions/memories in parallel. (#24)
- **Server-side dedup**: Repo context calls return only repo-specific data after workspace loaded. (#25)

### Removed
- `publish-npm.yml` workflow (binary-only distribution)
- `axme_search_memory` tool (replaced by `axme_memories`)
- `checkMergedBranch` / `detectBranch` (replaced by #!axme gate)
- cd/pushd/cwd tracking in pre-tool-use hook (no longer needed with gate)

## [0.1.0] - 2026-04-07

Initial release.
- MCP server with persistent memory, decisions, safety guardrails
- Session tracking with background auditor
- Safety hooks (pre-tool-use, post-tool-use)
- Multi-repo workspace support
- Binary installer (linux/macOS, x64/arm64)
- npm package @axme/code
