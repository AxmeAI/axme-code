/**
 * Safety Scanner Agent - read-only LLM agent that detects safety rules
 * from CI configs, pre-commit hooks, and project configuration.
 *
 * Model: Haiku (fast, cheap - just reading configs)
 * Tools: Read, Glob, Grep, Bash (read-only)
 * Budget: $0.50 max
 */

import type { SafetyRules } from "../../types.js";
import { extractCostFromResult, zeroCost, type CostInfo } from "../../utils/cost-extractor.js";
import { buildAgentQueryOptions } from "../../utils/agent-options.js";

export interface SafetyScanResult {
  rules: Partial<SafetyRules>;
  summary: string;
  cost: CostInfo;
  durationMs: number;
}

const SAFETY_SCAN_PROMPT = `You are a safety analyst. Your job is to scan this project's CI/CD configs and development tooling to extract safety rules.

## Instructions

Read these files if they exist:
1. .github/workflows/*.yml - CI pipeline configs (test commands, branch protection, deploy rules)
2. .gitlab-ci.yml, Jenkinsfile, .circleci/config.yml - other CI systems
3. .pre-commit-config.yaml - pre-commit hooks
4. .husky/ or .lefthook.yml - git hooks
5. Makefile, Taskfile.yml, Justfile - task runners (find test/lint/build commands)
6. .git/config - branch settings
7. CODEOWNERS, .github/CODEOWNERS - ownership rules
8. Dockerfile, docker-compose.yml - container configs
9. .gitignore - what's excluded from git
10. **CLAUDE.md** - read COMPLETELY for prohibited commands, safety rules, workflow restrictions
    - Also check .claude/CLAUDE.md, .claude/rules/*.md, .claudecode/rules.md
    - If CLAUDE.md references other files with rules - follow and read them
11. **AGENTS.md** - may contain safety constraints
12. **Claude auto-memory** - check ~/.claude/projects/<encoded-path>/memory/ for safety-related feedback
    (encoded-path = absolute project path with non-alphanumeric chars replaced by "-")

## What to extract

From CI configs, identify:
- Test commands that run on every PR (e.g., "npm test", "pytest", "go test ./...")
- Lint commands (e.g., "npm run lint", "ruff check", "golangci-lint run")
- Build commands (e.g., "npm run build", "go build ./...")
- Protected branches (which branches require CI to pass)
- Deploy commands (what deploys to staging/production)

From CLAUDE.md and agent instruction files, identify:
- **Prohibited commands** (e.g., "never run gh pr merge", "never push v* tags", "never npm publish")
- **Deploy restrictions** (e.g., "staging only via workflow", "prod deploy human-initiated only")
- **Git workflow rules** (e.g., "never push to main", "always use feature branches")
- **File protection rules** (e.g., "never modify .env", "never commit secrets")

From pre-commit hooks, identify:
- Which checks run before each commit
- Secret scanners (detect-secrets, ggshield, etc.)

From Claude auto-memory, identify:
- Past incidents that led to new safety rules
- Operational patterns that should be enforced

From Makefiles/Taskfiles, identify:
- Standard task commands that are safe to run

## Output Format

===SAFETY===
###GIT###
protectedBranches: [list of branches, e.g., main, develop]
###END###

###BASH_ALLOW###
[list of commands that are safe to auto-approve, one per line]
[e.g., npm test]
[e.g., pytest -q]
[e.g., go test ./...]
###END###

###BASH_DENY###
[list of commands that should be blocked, one per line]
[e.g., gcloud run deploy (if deploy should go through CI)]
[e.g., kubectl apply (if k8s deploys should go through CI)]
###END###

###SUMMARY###
[1-3 sentence summary of what was found]
###END###
===END===`;

export async function runSafetyScan(opts: {
  projectPath: string;
  model?: string;
  budgetUsd?: number;
}): Promise<SafetyScanResult> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const startTime = Date.now();
  const model = opts.model ?? "claude-haiku-4-5";
  const budgetUsd = opts.budgetUsd ?? 0.5;

  const queryOpts = buildAgentQueryOptions(
    { cwd: opts.projectPath, model, budgetUsd },
    "scanner",
  );

  const q = sdk.query({ prompt: SAFETY_SCAN_PROMPT, options: queryOpts });

  let result = "";
  let cost: CostInfo | undefined;

  for await (const msg of q) {
    if (msg.type === "assistant") {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) result += block.text;
        }
      }
    }
    if (msg.type === "result") {
      cost = extractCostFromResult(msg);
      if ((msg as any).subtype === "success" && (msg as any).result) {
        result = (msg as any).result;
      }
    }
  }

  const parsed = parseSafetyOutput(result);
  if (!cost) cost = zeroCost();

  return { rules: parsed.rules, summary: parsed.summary, cost, durationMs: Date.now() - startTime };
}

export function parseSafetyOutput(output: string): { rules: Partial<SafetyRules>; summary: string } {
  const rules: Partial<SafetyRules> = {};
  let summary = "";

  const gitMatch = output.match(/###GIT###\n([\s\S]*?)###END###/);
  if (gitMatch) {
    const branchesLine = gitMatch[1].match(/protectedBranches:\s*\[([^\]]*)\]/);
    if (branchesLine) {
      const branches = branchesLine[1].split(",").map(b => b.trim()).filter(Boolean);
      if (branches.length > 0) {
        rules.git = { protectedBranches: branches, allowForcePush: false, allowDirectPushToMain: false, requirePrForMain: true };
      }
    }
  }

  const allowMatch = output.match(/###BASH_ALLOW###\n([\s\S]*?)###END###/);
  if (allowMatch) {
    const commands = allowMatch[1].trim().split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("["));
    if (commands.length > 0) {
      rules.bash = { allowedPrefixes: commands, deniedPrefixes: [], deniedCommands: [] };
    }
  }

  const denyMatch = output.match(/###BASH_DENY###\n([\s\S]*?)###END###/);
  if (denyMatch) {
    const commands = denyMatch[1].trim().split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("["));
    if (commands.length > 0) {
      if (!rules.bash) rules.bash = { allowedPrefixes: [], deniedPrefixes: [], deniedCommands: [] };
      rules.bash.deniedPrefixes = commands;
    }
  }

  const summaryMatch = output.match(/###SUMMARY###\n([\s\S]*?)###END###/);
  if (summaryMatch) summary = summaryMatch[1].trim();

  return { rules, summary };
}
