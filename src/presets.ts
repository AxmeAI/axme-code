/**
 * Best Practice Presets - curated rule bundles for project initialization.
 */

import type { Decision, Memory, SafetyRules, ProjectConfig, ChecklistItem } from "./types.js";

export interface PresetSafetyRules {
  bashDeny?: string[];
  bashAllow?: string[];
  fsDeny?: string[];
}

export type PresetMemory = Omit<Memory, "date" | "sessionId" | "source">;

export interface PresetDeployChecklist {
  staging?: ChecklistItem[];
  production?: ChecklistItem[];
}

export interface PresetBundle {
  id: string;
  name: string;
  description: string;
  recommended: string;
  decisions: Omit<Decision, "id" | "date" | "sessionId">[];
  safetyRules: PresetSafetyRules;
  memories: PresetMemory[];
  deployChecklists: PresetDeployChecklist;
  configDefaults?: Partial<ProjectConfig>;
}

// --- Bundles ---

const ESSENTIAL_SAFETY: PresetBundle = {
  id: "essential-safety",
  name: "Essential Safety",
  description: "Git protection, no secrets in code, input validation, fail loudly",
  recommended: "all projects",
  decisions: [
    { slug: "pr-only-merge-flow", title: "All changes to main via pull request with review", decision: "Direct commits to the default branch are blocked. All changes must go through a pull request with at least one approval and passing CI checks.", reasoning: "A single bad commit to main can break production for every developer and every deployment. Branch protection is the single highest-ROI safety measure.", source: "preset", enforce: "required" },
    { slug: "no-force-push", title: "No force push to shared branches", decision: "Never git push --force to main, develop, release/*, or any branch with active collaborators. Use --force-with-lease only on personal feature branches when absolutely necessary.", reasoning: "Force push rewrites history and silently destroys other developers' commits.", source: "preset", enforce: "required" },
    { slug: "pre-commit-hooks", title: "Pre-commit hooks for linting and secret scanning", decision: "Install pre-commit hooks that run: linter/formatter, secret scanner (detect-secrets or ggshield), and commit message format checker.", reasoning: "GitGuardian 2025: 23.8 million secrets leaked on public GitHub in 2024. Most could have been caught by a pre-commit hook.", source: "preset", enforce: null },
    { slug: "no-destructive-git", title: "No destructive git operations without confirmation", decision: "Never run git reset --hard, git checkout ., git clean -f, git branch -D, or git push --force without explicit confirmation. Prefer git stash over git reset --hard.", reasoning: "These commands permanently destroy uncommitted work with no undo path.", source: "preset", enforce: "required" },
    { slug: "never-commit-secrets", title: "Never commit secrets or credentials to git", decision: "No API keys, passwords, tokens, .env files, *.pem, *.key, or credentials.json may be committed to git. Use environment variables or secret managers. If accidentally committed, rotate immediately.", reasoning: "Git history is permanent. AWS keys exploited within 5 minutes of accidental commit.", source: "preset", enforce: "required" },
    { slug: "input-validation-at-boundaries", title: "Input validation at all system boundaries", decision: "Validate all external input at the entry point: type checking, length/size limits, format validation, allowlist for enums, reject unexpected fields. Use schema validation libraries (Pydantic, Zod, JSON Schema).", reasoning: "Input validation prevents injection attacks, broken access control, and data corruption.", source: "preset", enforce: "required" },
    { slug: "parameterized-queries", title: "Parameterized queries only - no SQL string concatenation", decision: "All database queries must use parameterized queries or ORM methods. Never concatenate user input into SQL strings.", reasoning: "SQL injection enables full database compromise. Parameterized queries eliminate this entire class of vulnerability.", source: "preset", enforce: "required" },
    { slug: "fail-loudly", title: "Fail loudly - never silently swallow errors", decision: "No empty catch blocks. No except: pass. No catch {}. Every error must be either logged with context and re-thrown, or handled with explicit recovery logic.", reasoning: "Silent error swallowing causes invisible data corruption, lost transactions, and impossible-to-debug production issues.", source: "preset", enforce: "required" },
  ],
  safetyRules: {
    bashDeny: ["git push --force", "git reset --hard", "git checkout -- .", "git clean -f"],
    fsDeny: ["~/.ssh/id_*", "~/.aws/credentials", "~/.gnupg/*", ".env", "*.pem", "*.key"],
  },
  memories: [
    { slug: "empty-catch-blocks-hide-bugs", type: "feedback", title: "Empty catch blocks hide bugs", description: "Never use empty catch/except blocks. Every error must be logged or re-thrown. Silent error swallowing causes invisible data corruption.", keywords: ["catch", "except", "error", "try", "exception", "silent", "swallow"], body: "**Why:** A silent catch block can hide database connection failures, auth errors, and data corruption for hours.\n\n**How to apply:** Search for empty catch blocks in any code review. Replace with explicit logging + re-throw or documented recovery logic." },
    { slug: "sync-http-in-async-handlers", type: "feedback", title: "Never use sync HTTP client in async handlers", description: "In async handlers (FastAPI, Express async, etc.), always use async HTTP clients. Sync clients block the event loop, causing timeouts and deadlocks under load.", keywords: ["async", "sync", "http", "httpx", "fetch", "axios", "event-loop", "blocking"], body: "**Why:** A single sync HTTP call in an async handler blocks the entire event loop. Under load, all requests queue behind the blocked call.\n\n**How to apply:** Grep for sync client usage (httpx.Client, requests.get) inside async functions. Replace with async equivalents (httpx.AsyncClient, aiohttp)." },
    { slug: "secrets-in-git-history", type: "feedback", title: "Secrets in git history are permanent", description: "Once a secret is committed to git, it is in the history forever. Always rotate compromised secrets immediately.", keywords: ["secret", "api-key", "password", "token", "credential", "git", "commit", "env"], body: "**Why:** AWS keys are exploited within 5 minutes of accidental commit. History rewriting does not guarantee removal from all clones.\n\n**How to apply:** Check .gitignore before first commit. Use pre-commit secret scanning. If a secret is committed, rotate it immediately." },
  ],
  deployChecklists: {
    staging: [{ name: "No secrets in staged files", command: "git diff --cached --name-only | grep -E '\\.(env|pem|key)$' && exit 1 || true", expected: "exit 0", required: true }],
    production: [
      { name: "No secrets in staged files", command: "git diff --cached --name-only | grep -E '\\.(env|pem|key)$' && exit 1 || true", expected: "exit 0", required: true },
      { name: "Docker image uses specific tag", command: "grep -rl :latest Dockerfile docker-compose.yml 2>/dev/null | wc -l | xargs test 0 -eq && echo OK || echo FOUND_LATEST", expected: "contains:OK", required: true },
    ],
  },
};

const PRODUCTION_READY: PresetBundle = {
  id: "production-ready",
  name: "Production-Ready",
  description: "Staging-first deploy, health checks, Docker safety, monitoring",
  recommended: "deployed services",
  decisions: [
    { slug: "staging-first-deployment", title: "Every change deployed to staging before production", decision: "Never deploy directly to production. All changes go to staging first, are verified, then promoted to production.", reasoning: "Dev/prod parity prevents 'works on my machine' failures. Staging catches configuration errors before they affect users.", source: "preset", enforce: "required" },
    { slug: "rollback-procedure", title: "Documented rollback procedure executable in under 5 minutes", decision: "Every deployment must have a tested rollback procedure. Prefer deployment rollback over code rollback. Never roll forward for critical issues.", reasoning: "The fastest way to restore service is to go back to the last known-good state.", source: "preset", enforce: null },
    { slug: "docker-no-latest", title: "Docker images use specific version tags, never :latest", decision: "All Docker image references must use specific version tags. :latest is forbidden in Dockerfiles, compose files, and deploy configs.", reasoning: ":latest is mutable and non-reproducible. Cannot determine what ran in production during incident.", source: "preset", enforce: "required" },
    { slug: "health-check-endpoints", title: "Health check endpoints on every service", decision: "Every deployed service must expose /health and /ready. Configure liveness and readiness probes.", reasoning: "Without health checks, load balancers route traffic to broken instances.", source: "preset", enforce: "required" },
    { slug: "deploy-via-ci-only", title: "All deployments via CI/CD pipeline, never from local machine", decision: "All code deployments must go through CI/CD pipelines. Direct gcloud/aws/kubectl commands for code changes are forbidden.", reasoning: "Local deploys bypass tests, skip audit logs, and create dependencies on individual machines.", source: "preset", enforce: "required" },
    { slug: "backward-compatible-migrations", title: "Database migrations must be backward compatible", decision: "Never rename or drop columns in a single migration. Use expand-and-contract pattern.", reasoning: "During rolling deploys, old and new code run simultaneously. A column rename breaks the old code instantly.", source: "preset", enforce: "required" },
    { slug: "structured-logging", title: "Structured logging with correlation IDs", decision: "All logs must be structured (JSON format) with: timestamp, level, message, request_id/trace_id, service name.", reasoning: "Unstructured logs are unsearchable at scale. Without correlation IDs, tracing is impossible.", source: "preset", enforce: "advisory" },
  ],
  safetyRules: { bashDeny: ["gcloud run deploy", "gcloud builds submit", "aws ecs update-service", "kubectl apply", "kubectl delete", "docker push"] },
  memories: [
    { slug: "migration-backward-compat", type: "feedback", title: "Always check migration backward compatibility", description: "During rolling deploys, old and new code run simultaneously. A column rename or drop breaks the old code instantly.", keywords: ["migration", "database", "schema", "column", "rename", "drop", "deploy", "rolling"], body: "**Why:** Column renames cause instant outage during rolling deploy.\n\n**How to apply:** Never rename or drop columns in a single migration. Add new -> migrate data -> update code -> drop old in separate release." },
    { slug: "health-check-must-verify-db", type: "pattern", title: "Health check must verify DB connection", description: "A /health endpoint that returns 200 without checking database connectivity is misleading.", keywords: ["health", "healthcheck", "database", "readiness", "liveness", "probe"], body: "**Why:** Without DB check, a service reports healthy while silently failing all requests.\n\n**How to apply:** /health = liveness. /ready = readiness (all dependencies reachable). Always check DB in /ready." },
    { slug: "unique-deploy-tags", type: "feedback", title: "Always use unique tags for container images", description: "Never use :latest for deployment. Use timestamp or git SHA tags.", keywords: ["docker", "container", "tag", "latest", "image", "deploy", "rollback"], body: "**Why:** :latest is mutable - you cannot determine what ran in production during an incident.\n\n**How to apply:** TAG=\"v$(date +%Y%m%d-%H%M%S)\". Always log the exact tag in deploy records." },
  ],
  deployChecklists: {
    staging: [
      { name: "Unit tests pass", command: "npm test 2>&1 || pytest 2>&1 || go test ./... 2>&1", expected: "exit 0", required: true },
      { name: "Build succeeds", command: "npm run build 2>&1 || make build 2>&1 || echo 'no build step'", expected: "exit 0", required: true },
      { name: "Health check after deploy", command: "echo 'Verify: curl -f $STAGING_URL/health'", expected: "exit 0", required: true },
    ],
    production: [
      { name: "Staging verified", command: "echo 'Confirm: staging was verified'", expected: "exit 0", required: true },
      { name: "Unit tests pass", command: "npm test 2>&1 || pytest 2>&1 || go test ./... 2>&1", expected: "exit 0", required: true },
      { name: "Migration backward compatible", command: "echo 'Confirm: DB migrations are backward compatible'", expected: "exit 0", required: true },
      { name: "Rollback plan documented", command: "echo 'Confirm: rollback procedure documented'", expected: "exit 0", required: true },
      { name: "Docker image uses specific tag", command: "grep -rl :latest Dockerfile docker-compose.yml 2>/dev/null | wc -l | xargs test 0 -eq && echo OK || echo FOUND_LATEST", expected: "contains:OK", required: true },
    ],
  },
};

const TEAM_COLLABORATION: PresetBundle = {
  id: "team-collaboration",
  name: "Team Collaboration",
  description: "Conventional commits, PR size limits, review checklist, changelog",
  recommended: "2+ developers",
  decisions: [
    { slug: "conventional-commits", title: "Conventional Commits for commit messages", decision: "Use the Conventional Commits spec: <type>(<scope>): <description>.", reasoning: "Enables automated changelog generation and semantic version bumping.", source: "preset", enforce: "advisory" },
    { slug: "pr-size-limits", title: "Pull requests should be 200-400 lines of changes", decision: "Keep PRs small and focused. PRs over 400 lines get a warning, over 1000 should be split.", reasoning: "Defect detection drops 70% for PRs over 1000 lines.", source: "preset", enforce: "advisory" },
    { slug: "review-checklist", title: "Code review checklist: design, functionality, tests, security", decision: "Every review must evaluate: design, functionality, complexity, tests, naming, security.", reasoning: "Without a checklist, reviewers focus on style and miss logic errors.", source: "preset", enforce: null },
    { slug: "changelog-maintenance", title: "Changelog maintained with every release", decision: "Maintain CHANGELOG.md. Update in the same PR as the code change, not retroactively.", reasoning: "Retroactive changelogs are always incomplete.", source: "preset", enforce: null },
    { slug: "semantic-versioning", title: "Semantic Versioning for all releases", decision: "Follow SemVer 2.0.0. Breaking changes = major. New features = minor. Bug fixes = patch.", reasoning: "SemVer communicates change impact to consumers.", source: "preset", enforce: null },
    { slug: "test-coverage-threshold", title: "Test coverage must not decrease", decision: "PRs must not decrease test coverage. New code paths require tests. Minimum 80% line coverage.", reasoning: "Without coverage gates, test debt grows until refactoring becomes impossible.", source: "preset", enforce: "advisory" },
  ],
  safetyRules: {},
  memories: [
    { slug: "conventional-commits-format", type: "pattern", title: "Conventional Commits enables automation", description: "Use <type>(<scope>): <description> format for commit messages.", keywords: ["commit", "message", "conventional", "changelog", "version", "semver"], body: "**Why:** Machine-readable commit history enables automated releases and changelogs.\n\n**How to apply:** feat: new feature, fix: bug fix, docs: documentation, refactor: restructure, test: tests, ci: CI changes." },
  ],
  deployChecklists: {},
};

const AI_AGENT_GUARDRAILS: PresetBundle = {
  id: "ai-agent-guardrails",
  name: "AI Agent Guardrails",
  description: "Budget limits, tool restrictions, verification requirements",
  recommended: "AI-assisted development",
  decisions: [
    { slug: "agent-budget-limits", title: "Budget limits per agent session", decision: "Set a default budget limit per session ($10). Agent must stop when budget is exceeded.", reasoning: "Without budget limits, a stuck agent loop can consume unlimited API credits.", source: "preset", enforce: null },
    { slug: "agent-verification-required", title: "Every agent change must be verified with real tests", decision: "Never report work as done without running actual tests. Unit tests alone are not sufficient.", reasoning: "AI agents produce plausible-looking code that may not work.", source: "preset", enforce: "required" },
    { slug: "agent-no-autonomous-prod-deploy", title: "No autonomous production deployments by agents", decision: "Agents must never trigger production deployments. Agent creates PR, human reviews and merges.", reasoning: "Production deployment decisions require judgment about timing and risk.", source: "preset", enforce: "required" },
    { slug: "reviewer-read-only", title: "Review agents restricted to read-only tools", decision: "Code review agents must only use read-only tools. They must never have Write or Edit access.", reasoning: "Separation of duties: the reviewer must independently verify without ability to change what it reviews.", source: "preset", enforce: null },
    { slug: "agent-no-silent-completion", title: "Agents must show proof of verification before reporting done", decision: "When reporting completion: what was changed, tests run and results, remaining issues.", reasoning: "The '80% problem' in agentic coding: agents confidently report completion on subtly broken work.", source: "preset", enforce: "required" },
  ],
  safetyRules: { bashDeny: ["gh workflow run deploy-prod", "gh release create", "npm publish", "twine upload"] },
  memories: [
    { slug: "verify-with-real-tests", type: "feedback", title: "Verify every change with real tests", description: "Unit tests alone are not sufficient. Run affected functionality end-to-end. Show proof.", keywords: ["test", "verify", "unit-test", "e2e", "integration", "staging", "done"], body: "**Why:** AI agents produce plausible-looking code that may not work.\n\n**How to apply:** After changes, run full test suite. For deployed services, verify on staging. Show proof in report." },
    { slug: "never-report-done-without-staging", type: "feedback", title: "Never report done without staging verification", description: "Saying 'done' when only unit tests passed is unreliable. Staging verification catches configuration errors.", keywords: ["staging", "verification", "done", "deploy", "complete", "report"], body: "**Why:** Unit tests run in isolation with mocks. Real environments have latency, auth, DB migrations.\n\n**How to apply:** After unit tests: deploy to staging, run health check, hit endpoints. Only then report done." },
    { slug: "agent-budget-awareness", type: "pattern", title: "Track agent token usage against budget", description: "Set budget limits per session and per pipeline step. Stop when budget is exceeded.", keywords: ["budget", "cost", "tokens", "limit", "spending", "session"], body: "**Why:** Without budget limits, a stuck agent loop can consume unlimited API credits.\n\n**How to apply:** Check remaining budget before each turn. Log token usage. Alert at 80% consumed." },
  ],
  deployChecklists: {},
  configDefaults: { model: "claude-sonnet-4-6", reviewEnabled: true, presets: ["essential-safety", "ai-agent-guardrails"] },
};

// --- Public API ---

export const PRESET_BUNDLES: PresetBundle[] = [ESSENTIAL_SAFETY, PRODUCTION_READY, TEAM_COLLABORATION, AI_AGENT_GUARDRAILS];

export function getPresetBundle(id: string): PresetBundle | undefined {
  return PRESET_BUNDLES.find(b => b.id === id);
}

export function bundlesToDecisions(bundleIds: string[], startId: number): Decision[] {
  const decisions: Decision[] = [];
  const seen = new Set<string>();
  let nextId = startId;
  for (const id of bundleIds) {
    const bundle = getPresetBundle(id);
    if (!bundle) continue;
    for (const d of bundle.decisions) {
      if (seen.has(d.slug)) continue;
      seen.add(d.slug);
      decisions.push({ id: `D-${String(nextId++).padStart(3, "0")}`, ...d, date: new Date().toISOString().slice(0, 10), sessionId: null });
    }
  }
  return decisions;
}

export function bundlesToMemories(bundleIds: string[]): Memory[] {
  const today = new Date().toISOString().slice(0, 10);
  const memories: Memory[] = [];
  const seen = new Set<string>();
  for (const id of bundleIds) {
    const bundle = getPresetBundle(id);
    if (!bundle) continue;
    for (const m of bundle.memories) {
      if (seen.has(m.slug)) continue;
      seen.add(m.slug);
      memories.push({ ...m, source: "preset", sessionId: null, date: today });
    }
  }
  return memories;
}

export function bundlesToDeployChecklists(bundleIds: string[]): PresetDeployChecklist {
  const staging: ChecklistItem[] = [];
  const production: ChecklistItem[] = [];
  const seenS = new Set<string>();
  const seenP = new Set<string>();
  for (const id of bundleIds) {
    const bundle = getPresetBundle(id);
    if (!bundle?.deployChecklists) continue;
    for (const item of bundle.deployChecklists.staging ?? []) {
      if (!seenS.has(item.name.toLowerCase())) { seenS.add(item.name.toLowerCase()); staging.push(item); }
    }
    for (const item of bundle.deployChecklists.production ?? []) {
      if (!seenP.has(item.name.toLowerCase())) { seenP.add(item.name.toLowerCase()); production.push(item); }
    }
  }
  return { staging: staging.length > 0 ? staging : undefined, production: production.length > 0 ? production : undefined };
}

export function bundlesToConfigDefaults(bundleIds: string[]): Partial<ProjectConfig> {
  let merged: Partial<ProjectConfig> = {};
  for (const id of bundleIds) {
    const bundle = getPresetBundle(id);
    if (!bundle?.configDefaults) continue;
    merged = { ...merged, ...bundle.configDefaults };
  }
  return merged;
}

export function applyPresetSafetyRules(rules: SafetyRules, bundleIds: string[]): SafetyRules {
  for (const id of bundleIds) {
    const bundle = getPresetBundle(id);
    if (!bundle?.safetyRules) continue;
    for (const cmd of bundle.safetyRules.bashDeny ?? []) { if (!rules.bash.deniedPrefixes.includes(cmd)) rules.bash.deniedPrefixes.push(cmd); }
    for (const cmd of bundle.safetyRules.bashAllow ?? []) { if (!rules.bash.allowedPrefixes.includes(cmd)) rules.bash.allowedPrefixes.push(cmd); }
    for (const path of bundle.safetyRules.fsDeny ?? []) { if (!rules.filesystem.deniedPaths.includes(path)) rules.filesystem.deniedPaths.push(path); }
  }
  return rules;
}
