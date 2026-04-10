# axme-code Telemetry — Technical Specification

**Status**: Backend ready. Client (this repo) needs implementation.
**Endpoint**: `POST /v1/telemetry/events` on AXME gateway (prod: `https://api.cloud.axme.ai`)
**Auth**: none (anonymous, public endpoint)
**Created**: 2026-04-10 by control-plane PR #195

## Why

Platform admin dashboard tracks `axme-code` adoption (installs, DAU, version distribution, sources, activation rate). Without client-side telemetry events nothing is visible. The user-facing flow is anonymous — no `org_id`, no email, only an opaque random `mid` (machine ID).

## Endpoint contract

```
POST https://api.cloud.axme.ai/v1/telemetry/events
Content-Type: application/json

{
  "events": [
    {
      "event": "install" | "startup" | "update",
      "version": "0.2.6",
      "source": "binary" | "plugin",
      "os": "linux" | "darwin" | "win32",
      "arch": "x64" | "arm64",
      "ci": false,
      "mid": "<64 hex chars>",
      "ts": "2026-04-10T12:00:00Z"
    }
    // up to 10 events per request (batch allowed for offline queue)
  ]
}
```

**Response** (always `200`, fire-and-forget):
```json
{ "ok": true }
```

The server **never** returns an error to the client — invalid events are silently dropped server-side. Client must NOT retry on non-2xx, NOT throw on network errors, NOT block any user-visible operation on the result of this call. It is purely best-effort.

## Field semantics

| Field | Type | Required | Notes |
|---|---|---|---|
| `event` | string | yes | One of: `install`, `startup`, `update` |
| `version` | string | yes | semver, e.g. `0.2.6`. The same `__VERSION__` esbuild already injects |
| `source` | string | yes | `binary` for install.sh / GitHub Releases binary, `plugin` for Claude Code plugin |
| `os` | string | yes | `process.platform` Node value: `linux`, `darwin`, `win32` |
| `arch` | string | yes | `process.arch` Node value: `x64`, `arm64` |
| `ci` | boolean | no | `true` when running in CI (`process.env.CI === 'true'` or any `*_CI` envs); default `false` |
| `mid` | string | yes | Anonymous machine ID (see below) |
| `ts` | string | yes | ISO 8601 timestamp at the moment the event was generated client-side |

### Machine ID (`mid`)

- 64 hex chars (32 random bytes hex-encoded)
- Generate **once** per install on first run, persist to disk
- Storage location: `~/.local/share/axme-code/machine-id` (Linux/macOS), platform-equivalent on Windows
- File mode `0600`
- **Must NOT** be derived from hardware (no MAC address, no CPU serial, no hostname). Use `crypto.randomBytes(32).toString('hex')`
- If file exists, read it. If not, generate and write
- If file is corrupt or unreadable, regenerate (new mid). This is OK — analytics will treat it as a separate install which is the realistic behavior

### Event triggers

| Event | When to send |
|---|---|
| `install` | First time `axme-code` runs on this machine (mid file did not exist). Send immediately on first startup AFTER mid generation |
| `startup` | Every time `axme-code serve` (MCP server) or `axme-code` CLI starts. Includes plugin start (Claude Code launches the plugin) |
| `update` | When `axme-code` detects it has a different version than the previous run. Track previous version in same dir as mid (`~/.local/share/axme-code/last-version`) |

**Important**: each unique `axme-code serve` process should send exactly one `startup` event at boot, not multiple. Don't send on every MCP request.

### CI detection

Skip events when in CI (avoid skewing DAU). Detect via:
```ts
const isCI = !!(
  process.env.CI ||
  process.env.GITHUB_ACTIONS ||
  process.env.GITLAB_CI ||
  process.env.CIRCLECI ||
  process.env.BUILDKITE ||
  process.env.JENKINS_URL
);
```

If `isCI` is true, set `ci: true` in the event but **still send it** — the backend filter can use `ci=true` to exclude later. Don't drop events client-side, that loses information.

## Implementation requirements

### 1. Module placement

Create `src/telemetry.ts` (next to other top-level src files like `auto-update.ts`). Single module owns:
- mid generation/persistence
- last-version tracking
- event submission (fetch with timeout)
- offline queue (JSONL file in same dir)

### 2. Hot-path safety

Telemetry **must not block** server startup or CLI command execution:
- Use `setImmediate` or `void` to fire request asynchronously
- Wrap entire telemetry call in try/catch — never throw
- Network timeout 5 seconds max — don't wait longer than that
- If fetch fails, queue to JSONL file and retry on next startup (max queue size: 100 events, drop oldest)

### 3. Opt-out

Respect environment variable `AXME_TELEMETRY_DISABLED=1`. When set, the entire telemetry module is a no-op (no network, no file writes, no mid generation). Document this in README.

Also respect `DO_NOT_TRACK=1` (industry convention) — same behavior.

### 4. Endpoint URL configurability

Default endpoint: `https://api.cloud.axme.ai/v1/telemetry/events`

Override via env var: `AXME_TELEMETRY_ENDPOINT=https://staging-...` (useful for testing against staging gateway).

### 5. Privacy

- **Never** send: hostname, username, working directory, file paths, environment variables, command-line args
- **Never** log mid to console (it's anonymous but logging it makes it easy to leak)
- The mid file is the ONLY persistent state created by telemetry
- Document in README: "axme-code sends anonymous telemetry (install/startup/update events with random machine ID and version info). Disable with AXME_TELEMETRY_DISABLED=1."

## Wiring points

| File | Change |
|---|---|
| `src/server.ts` | Call `await sendTelemetry('startup', ...)` (non-blocking) right after MCP server starts listening. Also call `sendTelemetry('install', ...)` if mid was just generated, and `sendTelemetry('update', ...)` if version changed |
| `src/cli.ts` | Same pattern for CLI subcommands (`setup`, `serve`, `status`) — but only on first invocation in a session (use a per-process flag to avoid double-sending if cli.ts spawns server) |
| `src/telemetry.ts` | New file — implementation |
| `README.md` | Add "Telemetry" section explaining what is sent, why, and how to disable |
| `test/telemetry.test.ts` | New test file — verify mid generation, file persistence, CI detection, AXME_TELEMETRY_DISABLED opt-out, queue logic |

## Testing

```bash
# Local testing against staging
AXME_TELEMETRY_ENDPOINT=https://axme-gateway-staging-uc2bllq3la-uc.a.run.app/v1/telemetry/events \
  node dist/server.js
```

Verify event lands in DB:
```bash
# (server-side, control-plane operator)
# Query staging telemetry_events table via cloud-sql-proxy or admin endpoint:
curl -H "x-api-key: $STG_KEY" \
  https://axme-gateway-staging-uc2bllq3la-uc.a.run.app/admin/code/overview
```

Should show install/startup counts including your test events.

## Verification checklist for the implementing agent

- [ ] `src/telemetry.ts` created with mid generation, persistence, send, queue, opt-out
- [ ] mid file at `~/.local/share/axme-code/machine-id` mode 0600, 64 hex chars
- [ ] `install` event fires on first run only (mid file didn't exist)
- [ ] `startup` event fires on every server/CLI start (once per process)
- [ ] `update` event fires when version differs from `last-version` file
- [ ] `AXME_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` fully disable telemetry (no network, no file writes)
- [ ] Server startup is NOT blocked by telemetry — kill network and verify boot still works fast
- [ ] Offline queue caps at 100 events
- [ ] CI envs detected → `ci: true` in event
- [ ] No PII, no paths, no hostname in any field
- [ ] Tests cover: mid generation, opt-out, CI detection, queue, send error handling
- [ ] README has Telemetry section
- [ ] After local test against staging, verify event appears in `/admin/code/overview` (installs_total +1, dau +1)

## Backend-side reference

Endpoint code (already deployed to staging, will be in prod after PR #195 merges):
- `services/gateway/misc_routes.py` — `POST /v1/telemetry/events` handler
- `services/gateway/migrations/0057_telemetry_events.{postgresql,sqlite}.sql` — schema
- `services/gateway/admin_routes.py` — `GET /admin/code/overview` aggregations

Schema (PostgreSQL):
```sql
CREATE TABLE telemetry_events (
    id          BIGSERIAL    PRIMARY KEY,
    event       VARCHAR(20)  NOT NULL,
    version     VARCHAR(20)  NOT NULL,
    source      VARCHAR(20)  NOT NULL,
    os          VARCHAR(20)  NOT NULL,
    arch        VARCHAR(20)  NOT NULL,
    ci          BOOLEAN      NOT NULL DEFAULT FALSE,
    mid         VARCHAR(64)  NOT NULL,
    ts          TIMESTAMPTZ  NOT NULL,
    received_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

Aggregations the backend computes:
- `installs_total` — distinct mid where event=install
- `installs_7d`, `installs_24h` — windowed
- `dau`, `wau`, `mau` — distinct mid with startup in window
- `activation_rate_pct` — % of installs that have ≥1 startup event after install
- `versions` (top 20 last 7 days) — distinct mid per version
- `sources` — distinct mid per source (binary vs plugin)
- `install_growth_30d` — daily install counts last 30 days

## Out of scope (do NOT implement)

- Linking mid to AXME org_id (would break anonymity guarantee)
- Sending command names, working dirs, or any path info
- Sending count of MCP tool calls (separate concern, much later)
- Geolocation / IP-based regions
- Telemetry config UI in `axme-code setup` (just env var opt-out is enough for alpha)

---

# Phase 2 — Product health events

**Status**: Specification only. Phase 1 (install/startup/update) must ship first.

## Why a Phase 2

Phase 1 answers "are users installing it?". It does **not** answer two questions that turned out to be critical during alpha:

1. **"Is the session auditor actually saving anything?"** — On 2026-04-09 we discovered the auditor was producing 0 extractions on long transcripts because the LLM kept drifting from the output format. We only noticed because we manually inspected `.axme-code/audit-logs/` while debugging another issue. Five blind re-runs at $1+ each before we had any signal. With telemetry on `audit_complete` we would have seen the problem the day it shipped.

2. **"Does setup actually complete for new users?"** — `axme-code setup` runs four LLM scanners in parallel. Any of them can fail (timeout, no API key, model error). When it falls back to the deterministic path, the user has a working install but is silently missing the LLM-extracted oracle. From `install` + `startup` events alone, this looks identical to a healthy install. We have no way to know the activation funnel is leaking until users complain.

These two events plus a generic `error` channel unlock the failure-mode visibility we are missing. Phase 1 covers reach; Phase 2 covers product health.

## New events

### Event types

| Event | When | Frequency per user |
|---|---|---|
| `audit_complete` | After `runSessionCleanup` finishes (success or LLM error) | ~1 per Claude Code session close |
| `setup_complete` | After `axme-code setup` finishes (success or fallback) | Once per project init (rare) |
| `error` | Caught error in audit / setup / hook / mcp_tool path | Variable, ideally rare |

All three carry the same common fields as Phase 1 events (`event`, `version`, `source`, `os`, `arch`, `ci`, `mid`, `ts`) PLUS the event-specific fields below.

### `audit_complete` payload

```json
{
  "event": "audit_complete",
  "version": "0.2.6",
  "source": "binary",
  "os": "linux",
  "arch": "x64",
  "ci": false,
  "mid": "<64 hex chars>",
  "ts": "2026-04-10T12:00:00Z",

  "outcome": "success" | "failed" | "skipped",
  "duration_ms": 415000,
  "prompt_tokens": 134116,
  "cost_usd": 1.58,
  "chunks": 1,

  "memories_saved": 2,
  "decisions_saved": 0,
  "safety_saved": 0,
  "dropped_count": 0,

  "error_class": null
}
```

**Field semantics:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `outcome` | string | yes | `success` (audit ran, parsed, saved), `failed` (LLM/parse/network error), `skipped` (ghost session, already audited, retry cap reached) |
| `duration_ms` | int | yes | Wall-clock duration of the audit run from start to finish, including all LLM calls |
| `prompt_tokens` | int | yes | Sum of analysis-phase prompt tokens across all chunks. 0 if skipped |
| `cost_usd` | number | yes | Total LLM cost for this audit (analysis + format calls). 0 if skipped |
| `chunks` | int | yes | Number of LLM call chunks (1 for short transcripts, >1 for split ones) |
| `memories_saved` | int | yes | Number of memories actually written to storage (after dedup) |
| `decisions_saved` | int | yes | Number of decisions actually written (after dedup) |
| `safety_saved` | int | yes | Number of safety rules actually written (after dedup) |
| `dropped_count` | int | yes | Number of extraction blocks the parser dropped due to missing required fields. **High value here = format drift, the bug we hit on 2026-04-09** |
| `error_class` | string\|null | no | Set when `outcome=failed`. Short slug like `prompt_too_long`, `parse_error`, `network_error`, `timeout`, `api_error` |

**No** raw text, slugs, titles, paths, or transcript content. Only counts and classes.

### `setup_complete` payload

```json
{
  "event": "setup_complete",
  "version": "0.2.6",
  "source": "binary",
  "os": "linux",
  "arch": "x64",
  "ci": false,
  "mid": "<64 hex chars>",
  "ts": "2026-04-10T12:00:00Z",

  "outcome": "success" | "fallback" | "failed",
  "duration_ms": 45000,
  "method": "llm" | "deterministic",
  "scanners_run": 4,
  "scanners_failed": 0,
  "phase_failed": null,

  "presets_applied": 2,
  "is_workspace": false,
  "child_repos": 0
}
```

**Field semantics:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `outcome` | string | yes | `success` (LLM init worked end-to-end), `fallback` (LLM init failed/skipped, deterministic fallback used and project IS usable), `failed` (everything failed, project unusable) |
| `duration_ms` | int | yes | Wall-clock setup time |
| `method` | string | yes | `llm` if any LLM scanner ran, `deterministic` if pure fallback |
| `scanners_run` | int | yes | How many of the 4 scanners (oracle/decision/safety/deploy) actually executed |
| `scanners_failed` | int | yes | How many of those returned an error |
| `phase_failed` | string\|null | no | When `outcome=failed`, name of phase: `oracle_scan`, `decision_scan`, `safety_scan`, `deploy_scan`, `preset_apply`, `mcp_config_write`, `claude_md_write` |
| `presets_applied` | int | yes | Count of preset bundles applied (0-4) |
| `is_workspace` | bool | yes | True if the target was a workspace root (multi-repo) |
| `child_repos` | int | yes | Number of child repos detected in the workspace (0 for single-repo) |

### `error` payload

```json
{
  "event": "error",
  "version": "0.2.6",
  "source": "binary",
  "os": "linux",
  "arch": "x64",
  "ci": false,
  "mid": "<64 hex chars>",
  "ts": "2026-04-10T12:00:00Z",

  "category": "audit" | "setup" | "hook" | "mcp_tool" | "auto_update",
  "error_class": "string slug",
  "fatal": false
}
```

**Field semantics:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `category` | string | yes | Subsystem where the error originated. One of: `audit`, `setup`, `hook`, `mcp_tool`, `auto_update` |
| `error_class` | string | yes | Short slug, **not** a free-text message. Examples: `prompt_too_long`, `oauth_missing`, `api_rate_limit`, `transcript_not_found`, `parse_error`, `disk_full`, `permission_denied`, `network_error`, `unknown` |
| `fatal` | bool | yes | True if the error caused the operation to abort entirely (vs degraded mode) |

**Critical**: `error_class` must be a short, **bounded vocabulary** of slugs decided by the client code, not raw exception messages. Raw exception messages can leak file paths, usernames, or PII. The client maps caught exceptions to a known set of slugs (with `unknown` as the catch-all) before sending.

## Backend changes required

### Schema

Two options:

**Option A — single wide table (simpler):** Add nullable columns to `telemetry_events`:

```sql
ALTER TABLE telemetry_events ADD COLUMN outcome       VARCHAR(20);
ALTER TABLE telemetry_events ADD COLUMN duration_ms   INTEGER;
ALTER TABLE telemetry_events ADD COLUMN cost_usd      NUMERIC(10,4);
ALTER TABLE telemetry_events ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE telemetry_events ADD COLUMN chunks        INTEGER;
ALTER TABLE telemetry_events ADD COLUMN memories_saved  INTEGER;
ALTER TABLE telemetry_events ADD COLUMN decisions_saved INTEGER;
ALTER TABLE telemetry_events ADD COLUMN safety_saved    INTEGER;
ALTER TABLE telemetry_events ADD COLUMN dropped_count   INTEGER;
ALTER TABLE telemetry_events ADD COLUMN method          VARCHAR(20);
ALTER TABLE telemetry_events ADD COLUMN scanners_run    INTEGER;
ALTER TABLE telemetry_events ADD COLUMN scanners_failed INTEGER;
ALTER TABLE telemetry_events ADD COLUMN phase_failed    VARCHAR(40);
ALTER TABLE telemetry_events ADD COLUMN presets_applied INTEGER;
ALTER TABLE telemetry_events ADD COLUMN is_workspace    BOOLEAN;
ALTER TABLE telemetry_events ADD COLUMN child_repos     INTEGER;
ALTER TABLE telemetry_events ADD COLUMN category        VARCHAR(20);
ALTER TABLE telemetry_events ADD COLUMN error_class     VARCHAR(40);
ALTER TABLE telemetry_events ADD COLUMN fatal           BOOLEAN;

CREATE INDEX idx_telemetry_events_event_ts ON telemetry_events (event, ts DESC);
CREATE INDEX idx_telemetry_events_outcome ON telemetry_events (outcome) WHERE outcome IS NOT NULL;
CREATE INDEX idx_telemetry_events_error_class ON telemetry_events (category, error_class) WHERE error_class IS NOT NULL;
```

**Option B — JSONB blob (more flexible):** Add a single `payload JSONB` column for event-specific fields. Trade-off: easier to evolve, harder to query/index.

Recommendation: **Option A** for alpha. Bounded set of fields, predictable queries, fast indexes. Switch to JSONB later if events keep multiplying.

### Endpoint validation

`POST /v1/telemetry/events` already accepts arbitrary fields per event. The backend handler must:

1. Accept the new event types (`audit_complete`, `setup_complete`, `error`) without rejecting
2. Map known optional fields into the new columns; unknown fields silently ignored
3. Do NOT enforce required fields beyond what Phase 1 already requires (`event`, `version`, `source`, `os`, `arch`, `mid`, `ts`) — server-side rejection is bad for telemetry; clients can be on old versions

### Aggregations / dashboard panels

Add these aggregations alongside the existing Phase 1 ones in `GET /admin/code/overview`. Backend should compute and return them in the same response so dashboard can render in one call.

#### Panel 1 — Audit health (the most important)

```sql
-- Audit success rate (last 7 days)
SELECT
  COUNT(*) FILTER (WHERE outcome = 'success')::float / NULLIF(COUNT(*), 0) AS success_rate,
  COUNT(*) FILTER (WHERE outcome = 'failed')  AS failed_count,
  COUNT(*) FILTER (WHERE outcome = 'success') AS success_count,
  COUNT(*) FILTER (WHERE outcome = 'skipped') AS skipped_count
FROM telemetry_events
WHERE event = 'audit_complete' AND ts > NOW() - INTERVAL '7 days' AND ci = false;

-- Average extractions per successful audit
SELECT
  AVG(memories_saved)  AS avg_memories,
  AVG(decisions_saved) AS avg_decisions,
  AVG(safety_saved)    AS avg_safety,
  AVG(dropped_count)   AS avg_dropped
FROM telemetry_events
WHERE event = 'audit_complete' AND outcome = 'success'
  AND ts > NOW() - INTERVAL '7 days' AND ci = false;

-- % of audits with ZERO extractions (the silent failure mode)
SELECT
  COUNT(*) FILTER (WHERE memories_saved = 0 AND decisions_saved = 0 AND safety_saved = 0)::float
  / NULLIF(COUNT(*), 0) AS zero_extraction_rate
FROM telemetry_events
WHERE event = 'audit_complete' AND outcome = 'success'
  AND ts > NOW() - INTERVAL '7 days' AND ci = false;

-- Top error classes
SELECT error_class, COUNT(*) AS cnt
FROM telemetry_events
WHERE event = 'audit_complete' AND outcome = 'failed'
  AND ts > NOW() - INTERVAL '7 days' AND ci = false
GROUP BY error_class ORDER BY cnt DESC LIMIT 10;

-- Cost distribution (need to know if anyone is burning $$)
SELECT
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY cost_usd) AS p50_cost,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY cost_usd) AS p95_cost,
  MAX(cost_usd) AS max_cost,
  SUM(cost_usd) AS total_cost
FROM telemetry_events
WHERE event = 'audit_complete' AND outcome = 'success'
  AND ts > NOW() - INTERVAL '7 days' AND ci = false;

-- Duration distribution
SELECT
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
FROM telemetry_events
WHERE event = 'audit_complete' AND outcome = 'success'
  AND ts > NOW() - INTERVAL '7 days' AND ci = false;
```

**Dashboard display for Audit health panel:**

- **Big number cards**: Audit success rate %, zero-extraction rate %, total cost 7d
- **Bar chart**: top error classes (last 7 days)
- **Trend line**: avg memories+decisions+safety per audit, daily, last 30 days. **A drop here is the early warning sign.**
- **Stacked bar**: outcomes per day (success / failed / skipped)
- **Table**: cost p50/p95/max, duration p50/p95

Why these specific cuts:
- **Zero-extraction rate** is the metric that would have caught our 2026-04-09 bug instantly
- **Top error classes** shows whether failures cluster (one fixable bug) or scatter (many small ones)
- **Cost p95** tells us if some users have runaway audit costs

#### Panel 2 — Setup health (activation funnel)

```sql
-- Setup outcome distribution (last 30 days)
SELECT outcome, COUNT(DISTINCT mid) AS users
FROM telemetry_events
WHERE event = 'setup_complete' AND ts > NOW() - INTERVAL '30 days' AND ci = false
GROUP BY outcome;

-- Where setup fails most
SELECT phase_failed, COUNT(*) AS cnt
FROM telemetry_events
WHERE event = 'setup_complete' AND outcome = 'failed' AND phase_failed IS NOT NULL
  AND ts > NOW() - INTERVAL '30 days' AND ci = false
GROUP BY phase_failed ORDER BY cnt DESC;

-- LLM vs deterministic split
SELECT method, COUNT(*) AS cnt
FROM telemetry_events
WHERE event = 'setup_complete' AND ts > NOW() - INTERVAL '30 days' AND ci = false
GROUP BY method;

-- Setup duration p50/p95
SELECT
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
FROM telemetry_events
WHERE event = 'setup_complete' AND outcome IN ('success', 'fallback')
  AND ts > NOW() - INTERVAL '30 days' AND ci = false;

-- Setup-to-first-startup activation (Phase 1 already has activation_rate_pct
-- but it counts install→startup. This is install→setup→startup which is more meaningful):
WITH installed AS (
  SELECT mid, MIN(ts) AS install_ts
  FROM telemetry_events WHERE event = 'install' AND ci = false GROUP BY mid
),
setup_done AS (
  SELECT mid FROM telemetry_events
  WHERE event = 'setup_complete' AND outcome IN ('success', 'fallback') AND ci = false
)
SELECT
  COUNT(*) FILTER (WHERE sd.mid IS NOT NULL)::float / NULLIF(COUNT(*), 0) AS setup_completion_rate
FROM installed i LEFT JOIN setup_done sd ON i.mid = sd.mid
WHERE i.install_ts > NOW() - INTERVAL '30 days';
```

**Dashboard display for Setup health panel:**

- **Funnel chart**: install → setup_complete(success+fallback) → startup
- **Pie chart**: outcome distribution (success / fallback / failed)
- **Bar chart**: phase_failed counts when outcome=failed
- **Big number**: % of installs that completed setup
- **Big number**: LLM vs deterministic ratio (tells us how many users have ANTHROPIC_API_KEY / claude subscription configured)
- **Histogram**: setup duration buckets (<10s, 10-30s, 30-60s, 60-120s, 120s+)

Why:
- **Funnel** shows where users drop off in onboarding. install but no setup = blocker before setup starts. setup but no startup = MCP integration broken.
- **Phase failed bars** tells us which scanner crashes most. If it's always `oracle_scan`, we know where to fix.
- **LLM ratio** is a rough proxy for "users with valid Claude credentials". Low ratio → most users hit fallback → they don't get the LLM benefits.

#### Panel 3 — Errors

```sql
-- Errors by category (last 7 days)
SELECT category, COUNT(*) AS cnt, COUNT(DISTINCT mid) AS users
FROM telemetry_events
WHERE event = 'error' AND ts > NOW() - INTERVAL '7 days' AND ci = false
GROUP BY category ORDER BY cnt DESC;

-- Top error classes overall
SELECT category, error_class, COUNT(*) AS cnt, COUNT(DISTINCT mid) AS users
FROM telemetry_events
WHERE event = 'error' AND ts > NOW() - INTERVAL '7 days' AND ci = false
GROUP BY category, error_class ORDER BY cnt DESC LIMIT 20;

-- Fatal vs non-fatal split
SELECT category, fatal, COUNT(*) AS cnt
FROM telemetry_events
WHERE event = 'error' AND ts > NOW() - INTERVAL '7 days' AND ci = false
GROUP BY category, fatal;

-- Error rate per active user (errors per DAU)
WITH errors_7d AS (
  SELECT COUNT(*) AS err_count FROM telemetry_events
  WHERE event = 'error' AND ts > NOW() - INTERVAL '7 days' AND ci = false
),
dau_7d AS (
  SELECT COUNT(DISTINCT mid) AS user_count FROM telemetry_events
  WHERE event = 'startup' AND ts > NOW() - INTERVAL '7 days' AND ci = false
)
SELECT err_count::float / NULLIF(user_count, 0) AS errors_per_active_user
FROM errors_7d, dau_7d;
```

**Dashboard display for Errors panel:**

- **Stacked bar**: errors per day, stacked by category
- **Table**: top 20 (category, error_class, count, distinct users)
- **Big number**: errors per active user, this week
- **Big number**: % of errors that are fatal

### Suggested admin endpoint extensions

`GET /admin/code/overview` should add a `phase2` block to the JSON response:

```json
{
  "phase1": { /* existing install/startup/update aggregations */ },
  "phase2": {
    "audit": {
      "success_rate_7d": 0.92,
      "zero_extraction_rate_7d": 0.05,
      "avg_memories_saved": 1.3,
      "avg_decisions_saved": 0.4,
      "avg_safety_saved": 0.1,
      "avg_dropped_count": 0.0,
      "total_cost_usd_7d": 12.50,
      "p50_duration_ms": 180000,
      "p95_duration_ms": 420000,
      "p50_cost_usd": 0.45,
      "p95_cost_usd": 1.80,
      "outcomes_7d": [
        { "date": "2026-04-04", "success": 12, "failed": 1, "skipped": 0 },
        ...
      ],
      "top_error_classes": [
        { "error_class": "prompt_too_long", "count": 3 },
        { "error_class": "parse_error", "count": 1 }
      ]
    },
    "setup": {
      "completion_rate_30d": 0.87,
      "outcomes_30d": { "success": 45, "fallback": 8, "failed": 4 },
      "method_30d": { "llm": 50, "deterministic": 7 },
      "phase_failed_30d": [
        { "phase_failed": "oracle_scan", "count": 3 },
        { "phase_failed": "preset_apply", "count": 1 }
      ],
      "p50_duration_ms": 35000,
      "p95_duration_ms": 90000
    },
    "errors": {
      "by_category_7d": [
        { "category": "audit", "count": 5, "users": 2 },
        { "category": "hook", "count": 2, "users": 2 }
      ],
      "top_classes_7d": [
        { "category": "audit", "error_class": "prompt_too_long", "count": 3, "users": 1 },
        ...
      ],
      "errors_per_active_user_7d": 0.18,
      "fatal_pct_7d": 0.4
    }
  }
}
```

The dashboard can render Phase 2 panels conditionally — if `phase2.audit.outcomes_7d` is empty (no clients have upgraded yet), hide the panel.

## Client implementation plan (axme-code side)

These are notes for the client implementation (in this repo), not the backend. Backend agent does NOT need to implement any of this.

### `audit_complete` wiring

In `src/session-cleanup.ts`, at the end of `runSessionCleanup`:

```ts
// After all writes are done, before return
sendTelemetry("audit_complete", {
  outcome: result.skipped ? "skipped" : audit ? "success" : "failed",
  duration_ms: Date.now() - auditStartMs,
  prompt_tokens: audit?.promptTokens ?? 0,
  cost_usd: audit?.cost?.costUsd ?? 0,
  chunks: audit?.chunks ?? 0,
  memories_saved: result.memories,
  decisions_saved: result.decisions,
  safety_saved: result.safetyRules,
  dropped_count: 0, // TODO: surface from parser
  error_class: lastAuditError ? classifyError(lastAuditError) : null,
});
```

The `dropped_count` requires the parser to return how many blocks it dropped. Add a counter to `parseAuditOutput` return value. Increment in every `process.stderr.write("AXME auditor: ... dropped ...")` site.

### `setup_complete` wiring

In `src/cli.ts`, after the `setup` subcommand completes (both success and failure paths):

```ts
sendTelemetry("setup_complete", {
  outcome: result.errors.length > 0 && !result.created ? "failed" :
           result.oracle.llm ? "success" : "fallback",
  duration_ms: Date.now() - setupStartMs,
  method: result.oracle.llm ? "llm" : "deterministic",
  scanners_run: result.scannersRun ?? 0, // need to track this
  scanners_failed: result.scannersFailed ?? 0,
  phase_failed: result.errors[0]?.phase ?? null, // need to add phase to errors
  presets_applied: result.presetsApplied ?? 0,
  is_workspace: result.isWorkspace ?? false,
  child_repos: result.childRepos ?? 0,
});
```

The result type needs to grow a few fields to make this clean. That's a small refactor in `tools/init.ts`.

### `error` wiring

Helper:

```ts
// src/telemetry.ts
export function reportError(category: string, errorClass: string, fatal: boolean) {
  sendTelemetry("error", { category, error_class: errorClass, fatal });
}

// Bounded vocabulary of error classes
export type ErrorClass =
  | "prompt_too_long"
  | "api_error"
  | "api_rate_limit"
  | "oauth_missing"
  | "network_error"
  | "timeout"
  | "parse_error"
  | "transcript_not_found"
  | "permission_denied"
  | "disk_full"
  | "config_invalid"
  | "unknown";

export function classifyError(err: unknown): ErrorClass {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("prompt is too long") || msg.includes("max tokens")) return "prompt_too_long";
  if (msg.includes("rate limit") || msg.includes("429")) return "api_rate_limit";
  if (msg.includes("authentication") || msg.includes("api key")) return "oauth_missing";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (msg.includes("enoent") || msg.includes("transcript")) return "transcript_not_found";
  if (msg.includes("eacces") || msg.includes("permission denied")) return "permission_denied";
  if (msg.includes("enospc") || msg.includes("no space")) return "disk_full";
  if (msg.includes("network") || msg.includes("econnrefused") || msg.includes("fetch failed")) return "network_error";
  if (msg.includes("unexpected token") || msg.includes("invalid json") || msg.includes("parse")) return "parse_error";
  return "unknown";
}
```

The vocabulary is intentionally small. New error classes are added as we see `unknown` cluster around a specific cause in the dashboard.

Call sites:
- `src/agents/session-auditor.ts` — wrap LLM call in try/catch, report `audit` errors
- `src/tools/init.ts` — wrap each scanner, report `setup` errors with phase
- `src/hooks/*.ts` — caught errors get `hook` category (hooks are silent so this is the only signal)
- `src/server.ts` — MCP tool handler exceptions get `mcp_tool` category

### Privacy review of Phase 2 fields

Re-checking each new field for PII:

- All numeric counts: safe, no PII possible
- `outcome` enum: safe
- `phase_failed` enum: safe (bounded vocabulary)
- `category` enum: safe
- `error_class` slug: safe IF the client maps from caught exception to a bounded vocabulary slug. **The client must NEVER send the raw exception message.** This is the only privacy-sensitive guarantee in Phase 2.
- `is_workspace` bool: safe
- `child_repos` int: safe (just a count)
- `method` enum: safe
- `cost_usd` number: safe

No new mid generation, no new persisted state beyond Phase 1.

## Verification checklist (Phase 2, backend agent)

- [ ] `telemetry_events` table extended with the columns from Option A above
- [ ] Indexes added: `(event, ts)`, `(outcome) WHERE NOT NULL`, `(category, error_class) WHERE NOT NULL`
- [ ] `POST /v1/telemetry/events` accepts the 3 new event types and writes new fields
- [ ] `GET /admin/code/overview` returns `phase2` block with audit, setup, errors aggregations
- [ ] Dashboard renders 3 new panels (Audit health, Setup health, Errors) — hidden if section is empty
- [ ] Each panel matches the chart types listed above (big numbers, bars, funnel, table)
- [ ] All aggregation queries filter `ci = false` (CI runs would skew product metrics)
- [ ] `phase_failed`, `error_class`, `category`, `outcome`, `method` columns are indexed if you plan to filter by them in the dashboard
- [ ] Backwards compatible: clients on 0.2.x that only send Phase 1 events still work; new columns are nullable

## Out of scope (Phase 2)

Same as Phase 1, plus:
- Real-time alerts (we monitor by manually checking the dashboard for now)
- Per-version regression tracking (compare audit success rate v0.2.6 vs v0.2.7) — useful but not for first iteration
- Cost forecasting / budget alerts
- Heatmap of when audits run (time-of-day)

## Questions for control-plane team

If anything in this spec is unclear or you discover edge cases during implementation, post in the AXME control-plane PR #195 thread or ping George.
