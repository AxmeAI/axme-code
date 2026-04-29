# Changelog

## [0.5.0] - 2026-04-29

Skips 0.3.0 / 0.4.0 — combined release for native Windows support, multi-client docs surfacing, and the semantic-search MCP tools (B-005).

### Added

- **Native Windows support** (#122). axme-code now runs natively on Windows (x64 + arm64) without WSL2. Single TypeScript codebase produces 6 binary artifacts from one source tree (D-133, supersedes the now-obsolete D-120). New `install.ps1` downloads the standalone Node bundle into `%LOCALAPPDATA%\Programs\axme-code\`, generates a `.cmd` wrapper, and adds the dir to the User PATH. Three-OS CI matrix (ubuntu / macos / windows-latest) gates every PR. Production fixes: `atomicWrite` fsync uses a write-fd (Windows FlushFileBuffers needs write access); `findClaudePath` switches to `where.exe` and prefers the underlying `claude.exe` from `node_modules\@anthropic-ai\claude-code\bin\` over npm's `.cmd` shim (CVE-2024-27980 EINVAL avoided); `execSync("sleep")` replaced with `Atomics.wait` (POSIX `sleep` is missing on cmd.exe); 13 instances of `path.split("/").pop()` replaced with `path.basename()`. Hook commands written by `axme-code setup` now use absolute `node` + script path, all segments quoted, so they work cross-platform without PATH dependency. The plugin's SessionStart shell fragment moved into the new `check-init` Node subcommand. Verified end-to-end on Azure Win11 Pro 24H2 with real OAuth Claude session + detached audit worker (`audit_complete` event written, parent process can exit cleanly without orphaning the worker).
- **Semantic search MCP tools** (B-005, #124). Three new read-only tools: `axme_get_memory(slug)`, `axme_get_decision(id_or_slug)`, `axme_search_kb(query, type?, k?)`. The first two fetch full bodies on demand (useful in any mode). The third does brute-force cosine over Float32 embeddings of every memory + decision (~10ms at 1000 vectors, no native bindings). Embeddings produced locally by `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers` — runs on CPU, **no token cost**, no API calls, no key required.
- **Tiered context-loading mode** (B-005, #124). New `config.context.mode` field with values `full` (default, every memory + decision body loaded at session start — existing behaviour) and `search` (catalog only — title + 1-line description + `[type/enforce]` label, ~10× lower startup tokens). Switching is user-driven only: `axme-code config set context.mode search` (or env var `AXME_CONTEXT_MODE`, or hand-edit of `config.yaml`). When the user is on `full` mode and the KB exceeds 100 entries, `axme_context` emits a directive (MUST-style) instruction telling the agent to surface the option to the user and ask whether to run the install command.
- **Lazy install of the embeddings runtime** (B-005, #124). `@huggingface/transformers` (~100MB node_modules + ~30MB MiniLM ONNX weights cached at `~/.cache/huggingface/`) is **not** bundled into the binary. It installs into `~/.local/share/axme-code/runtime/` only when the user opts in via `axme-code config set context.mode search`. That command is atomic: install → reindex every memory + decision → write `context.mode = search`. If install or reindex fails, the config rolls back to `full` and an actionable error is printed.
- **`axme-code config get / set` CLI subcommand** (#124). Reads and writes `.axme-code/config.yaml` from the terminal. Currently supported keys: `context.mode` (the only set-able key in this release; get also exposes `model`, `auditor_model`, `review_enabled`).
- **`axme-code reindex` CLI subcommand** (#124). Force a full re-embed of every memory + decision into `.axme-code/_index/embeddings.json`. Useful after hand-editing markdown files or upgrading the runtime.
- **"Works With Any MCP Client" section in README** (#123). Surfaces multi-client compatibility (Cursor, Windsurf, Cline, Claude Desktop, any MCP client) that was previously documented only in `docs/MULTI_CLIENT.md`. Includes a compatibility matrix, the universal MCP server entry snippet, and per-client config-file paths. Hook-based features (safety enforcement, post-tool-use file tracker, background auditor) remain Claude Code-specific; MCP tools work everywhere.
- **Glama MCP directory validation Dockerfile** (#121). Minimal `Dockerfile` at repo root so https://glama.ai/mcp/servers/AxmeAI/axme-code can validate the server. Image installs via standard `install.sh` and exposes `axme-code serve` as ENTRYPOINT.
- **Glama directory claim** (#120). `glama.json` for ownership verification.
- **README SEO + star/watch CTA** (#119). First paragraph leads with niche keywords (persistent memory across sessions, pre-execution safety hooks, architectural decision enforcement, structured session handoff). ⭐/🔔/💬 CTA below badges. Description rewritten in same order. Topics expanded to 14. Homepage = code.axme.ai. GitHub Discussions enabled.
- **Plugin marketplace install instructions** (#118). README and site list `claude plugin marketplace add anthropics/claude-plugins-community` + `claude plugin install axme-code@claude-community` as the **recommended** install path. Standalone binary install demoted to "Option 2 — useful for scripting outside Claude Code".

### Fixed

- **Standalone bundle on Windows: SDK fallback crash** (#122 + #124). The Claude Agent SDK's own claude-binary resolution path (`fileURLToPath(import.meta.url)` followed by `require.resolve("./cli.js")`) crashes inside our esbuild-bundled CJS distribution because esbuild stubs `import_meta` as `{}` so `import_meta.url` is undefined. The pre-#122 workaround returned `undefined` from `claudePathForSdk()` on win32 to let the SDK use its fallback — that worked when running from `dist/` + `node_modules/` (SDK loaded as ESM, `import.meta.url` defined) but broke on the standalone bundle that `install.ps1` actually deploys. Fix (D-136): `claudePathForSdk()` now returns the concrete `claude.exe` path (derived from npm's `claude.cmd` shim location → `node_modules\@anthropic-ai\claude-code\bin\claude.exe`) on every platform, not undefined. Spawning `claude.exe` directly avoids both the SDK fallback crash AND CVE-2024-27980 EINVAL.
- **Cross-platform dynamic import of the embeddings runtime** (#124). `await import(absolutePath)` throws on Windows because Node treats raw `C:\...` paths as bare specifiers. Wrapping the resolved path with `pathToFileURL(...).href` produces a `file:///C:/...` URL that imports cleanly on every platform.

### Known requirement (Windows)

- **`axme-code config set context.mode search` requires Microsoft Visual C++ Redistributable** to be installed on Windows. The `onnxruntime-node` native binding (transitively required by `@huggingface/transformers`) loads `onnxruntime_binding.node` which depends on `vcruntime140.dll` / `msvcp140.dll`. On a fresh Windows install without VC++ Redist, `axme-code` now prints an actionable hint pointing to https://aka.ms/vs/17/release/vc_redist.x64.exe (~25 MB silent install) and the retry command. After installing the Redist, reindex completes in 5s for ~30 entries.

### Changed

- **Test count: 511 → 536** (+25 new tests across `test/embeddings.test.ts` (cosine math, topK ranking, JSON round-trip, mtime staleness, runtime detection) and `test/kb-search.test.ts` (3 handlers' fallback paths + format round-trip)).

## [0.2.9] - 2026-04-17

### Added
- **User-selectable auth mode** (#109): `axme-code setup` now detects both Claude subscription (OAuth) and `ANTHROPIC_API_KEY` in env. If both exist, prompts the user to choose. Choice persisted in `~/.config/axme-code/auth.yaml`. When `mode=subscription`, `ANTHROPIC_API_KEY` is deleted from subprocess env so Claude Code uses OAuth instead of hitting a zero-balance API key. New commands: `axme-code auth` (interactive), `axme-code auth status`, `axme-code auth use subscription|api_key`. All subprocesses (scanners, session-auditor, memory-extractor) go through the unified `buildAgentEnv()`.

### Fixed
- **`findClaudePath()` fallback for users without `claude` in PATH** (B-009, #110): v0.2.8 fixed B-006 by passing `pathToClaudeCodeExecutable`, but `findClaudePath()` used only `which claude` — new users with nvm-managed or non-global Claude installs still hit the original `fileURLToPath(undefined)` crash. Resolution now tries 5 sources in order: `AXME_CLAUDE_EXECUTABLE` env var, `CLAUDE_CODE_ENTRYPOINT` env var, `which claude`, standard install paths (`~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`), and nvm glob (`~/.nvm/versions/node/*/bin/claude`). Each candidate verified via `existsSync`. E2E tested with `claude` stripped from PATH — resolver found `/usr/local/bin/claude` via fallback.

### Security
- **Dependency patches** (#110): `hono` 4.12.12 → 4.12.14 (moderate, HTML injection in JSX SSR, via `@modelcontextprotocol/sdk`). `protobufjs` 7.5.4 → 7.5.5 (critical, arbitrary code execution, in `benchmarks/` only — not in product bundle). Both lockfile-only, 0 vulnerabilities remaining.

### Tests
- 8 new unit tests for `findClaudePath()` resolver: env var priority, non-existent path skip, step-1-beats-step-2, caching, cache reset, dev-machine smoke test.
- Total test count: 489 → 511.

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
