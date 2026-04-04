/**
 * Best Practice Presets - curated rule bundles for project initialization.
 */

import type { Decision, Memory, SafetyRules } from "./types.js";

export interface PresetBundle {
  id: string;
  name: string;
  description: string;
  recommended: string;
  decisions: Omit<Decision, "id" | "date" | "sessionId">[];
  safetyRules: { bashDeny?: string[]; bashAllow?: string[]; fsDeny?: string[] };
  memories: Omit<Memory, "date" | "sessionId" | "source">[];
}

// --- Bundles ---

const ESSENTIAL_SAFETY: PresetBundle = {
  id: "essential-safety",
  name: "Essential Safety",
  description: "Git protection, no secrets in code, input validation, fail loudly",
  recommended: "all projects",
  decisions: [
    { slug: "pr-only-merge-flow", title: "All changes to main via pull request", decision: "Direct commits to the default branch are blocked. All changes must go through a pull request with at least one approval and passing CI checks.", reasoning: "Branch protection is the single highest-ROI safety measure.", source: "preset", enforce: "required" },
    { slug: "no-force-push", title: "No force push to shared branches", decision: "Never git push --force to main, develop, release/*. Use --force-with-lease only on personal branches when necessary.", reasoning: "Force push rewrites history and destroys other developers' commits.", source: "preset", enforce: "required" },
    { slug: "no-destructive-git", title: "No destructive git operations without confirmation", decision: "Never run git reset --hard, git checkout ., git clean -f without explicit confirmation.", reasoning: "These commands permanently destroy uncommitted work.", source: "preset", enforce: "required" },
    { slug: "never-commit-secrets", title: "Never commit secrets or credentials to git", decision: "No API keys, passwords, tokens, .env files may be committed. Use environment variables or secret managers.", reasoning: "Git history is permanent. AWS keys exploited within 5 minutes of accidental commit.", source: "preset", enforce: "required" },
    { slug: "fail-loudly", title: "Fail loudly - never silently swallow errors", decision: "No empty catch blocks. No except: pass. Every error must be logged or re-thrown.", reasoning: "Silent error swallowing causes invisible data corruption.", source: "preset", enforce: "required" },
  ],
  safetyRules: {
    bashDeny: ["git push --force", "git reset --hard", "git checkout -- .", "git clean -f"],
    fsDeny: ["~/.ssh/id_*", "~/.aws/credentials", ".env", "*.pem", "*.key"],
  },
  memories: [
    { slug: "empty-catch-blocks-hide-bugs", type: "feedback", title: "Empty catch blocks hide bugs", description: "Never use empty catch/except blocks. Every error must be logged or re-thrown.", keywords: ["catch", "except", "error", "try", "exception", "silent"], body: "**Why:** A silent catch block can hide database connection failures, auth errors, and data corruption for hours.\n\n**How to apply:** Search for empty catch blocks in any code review. Replace with logging + re-throw." },
    { slug: "secrets-in-git-history", type: "feedback", title: "Secrets in git history are permanent", description: "Once committed, a secret is in history forever. Always rotate compromised secrets immediately.", keywords: ["secret", "api-key", "password", "token", "credential", "git"], body: "**Why:** AWS keys are exploited within 5 minutes of accidental commit.\n\n**How to apply:** Check .gitignore before first commit. Use pre-commit secret scanning." },
  ],
};

const AI_AGENT_GUARDRAILS: PresetBundle = {
  id: "ai-agent-guardrails",
  name: "AI Agent Guardrails",
  description: "Verification requirements, no autonomous prod deploy, proof of work",
  recommended: "AI-assisted development",
  decisions: [
    { slug: "agent-verification-required", title: "Every agent change must be verified with real tests", decision: "Never report work as done without running actual tests. Unit tests alone are not sufficient.", reasoning: "AI agents produce plausible-looking code that may not work.", source: "preset", enforce: "required" },
    { slug: "agent-no-autonomous-prod-deploy", title: "No autonomous production deployments", decision: "Agents must never trigger production deployments. Agent creates PR, human reviews and merges.", reasoning: "Production deployment decisions require judgment about timing and risk.", source: "preset", enforce: "required" },
    { slug: "agent-no-silent-completion", title: "Agents must show proof of verification", decision: "When reporting completion: what was changed, tests run and results, remaining issues. No 'trust me' summaries.", reasoning: "The '80% problem' in agentic coding: agents confidently report completion on subtly broken work.", source: "preset", enforce: "required" },
  ],
  safetyRules: {
    bashDeny: ["gh workflow run deploy-prod", "npm publish", "twine upload"],
  },
  memories: [
    { slug: "verify-with-real-tests", type: "feedback", title: "Verify every change with real tests", description: "Unit tests alone are not sufficient. Run affected functionality end-to-end. Show proof.", keywords: ["test", "verify", "unit-test", "e2e", "integration", "done"], body: "**Why:** AI agents introduce more bugs than human developers.\n\n**How to apply:** After changes, run full test suite. For deployed services, verify on staging with actual HTTP requests." },
  ],
};

const PRODUCTION_READY: PresetBundle = {
  id: "production-ready",
  name: "Production-Ready",
  description: "Staging-first deploy, health checks, Docker safety",
  recommended: "deployed services",
  decisions: [
    { slug: "staging-first-deployment", title: "Every change deployed to staging before production", decision: "Never deploy directly to production. All changes go to staging first, are verified, then promoted.", reasoning: "Dev/prod parity prevents 'works on my machine' failures.", source: "preset", enforce: "required" },
    { slug: "deploy-via-ci-only", title: "All deployments via CI/CD pipeline", decision: "All code deployments must go through CI/CD pipelines. Direct gcloud/aws/kubectl commands are forbidden.", reasoning: "Local deploys bypass tests and skip audit logs.", source: "preset", enforce: "required" },
    { slug: "health-check-endpoints", title: "Health check endpoints on every service", decision: "Every service must expose /health and /ready. Configure liveness and readiness probes.", reasoning: "Without health checks, load balancers route traffic to broken instances.", source: "preset", enforce: "required" },
  ],
  safetyRules: {
    bashDeny: ["gcloud run deploy", "gcloud builds submit", "docker push"],
  },
  memories: [],
};

const TEAM_COLLABORATION: PresetBundle = {
  id: "team-collaboration",
  name: "Team Collaboration",
  description: "Conventional commits, PR size limits, review checklist",
  recommended: "2+ developers",
  decisions: [
    { slug: "conventional-commits", title: "Conventional Commits for commit messages", decision: "Use <type>(<scope>): <description> format. Types: feat, fix, docs, refactor, test, ci, chore.", reasoning: "Enables automated changelog and semantic version bumping.", source: "preset", enforce: "advisory" },
    { slug: "pr-size-limits", title: "Pull requests should be 200-400 lines", decision: "Keep PRs small and focused. PRs over 400 lines get a warning, over 1000 should be split.", reasoning: "Defect detection drops 70% for PRs over 1000 lines.", source: "preset", enforce: "advisory" },
  ],
  safetyRules: {},
  memories: [],
};

// --- Public API ---

export const PRESET_BUNDLES: PresetBundle[] = [
  ESSENTIAL_SAFETY, AI_AGENT_GUARDRAILS, PRODUCTION_READY, TEAM_COLLABORATION,
];

export function getPresetBundle(id: string): PresetBundle | undefined {
  return PRESET_BUNDLES.find(b => b.id === id);
}

export function bundlesToDecisions(bundleIds: string[], startId: number): Decision[] {
  const decisions: Decision[] = [];
  const seenSlugs = new Set<string>();
  let nextId = startId;

  for (const id of bundleIds) {
    const bundle = getPresetBundle(id);
    if (!bundle) continue;
    for (const d of bundle.decisions) {
      if (seenSlugs.has(d.slug)) continue;
      seenSlugs.add(d.slug);
      decisions.push({
        id: `D-${String(nextId++).padStart(3, "0")}`,
        ...d,
        date: new Date().toISOString().slice(0, 10),
        sessionId: null,
      });
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

export function applyPresetSafetyRules(rules: SafetyRules, bundleIds: string[]): SafetyRules {
  for (const id of bundleIds) {
    const bundle = getPresetBundle(id);
    if (!bundle?.safetyRules) continue;
    for (const cmd of bundle.safetyRules.bashDeny ?? []) {
      if (!rules.bash.deniedPrefixes.includes(cmd)) rules.bash.deniedPrefixes.push(cmd);
    }
    for (const cmd of bundle.safetyRules.bashAllow ?? []) {
      if (!rules.bash.allowedPrefixes.includes(cmd)) rules.bash.allowedPrefixes.push(cmd);
    }
    for (const path of bundle.safetyRules.fsDeny ?? []) {
      if (!rules.filesystem.deniedPaths.includes(path)) rules.filesystem.deniedPaths.push(path);
    }
  }
  return rules;
}
