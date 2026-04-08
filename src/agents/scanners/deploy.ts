/**
 * Deploy Scanner Agent - read-only LLM agent that detects deploy configuration
 * from CI configs, Dockerfiles, deploy scripts, and infrastructure files.
 *
 * Model: Haiku (fast, cheap)
 * Tools: Read, Glob, Grep, Bash (read-only)
 * Budget: $0.50 max
 */

import type { ChecklistItem } from "../../types.js";
import { extractCostFromResult, zeroCost, type CostInfo } from "../../utils/cost-extractor.js";
import { buildAgentQueryOptions } from "../../utils/agent-options.js";

export interface DeployScanResult {
  stagingItems: ChecklistItem[];
  prodItems: ChecklistItem[];
  summary: string;
  cost: CostInfo;
  durationMs: number;
}

const DEPLOY_SCAN_PROMPT = `You are a deploy safety analyst. Your job is to scan this project's deployment configuration and propose pre-deploy checklist items.

## Instructions

Read these files if they exist:
1. Dockerfile, docker-compose.yml - container configs (check for :latest, multi-stage, non-root)
2. .github/workflows/*.yml - CI/CD pipelines (find deploy jobs, test requirements, environment gates)
3. .gitlab-ci.yml, Jenkinsfile, .circleci/config.yml - other CI systems
4. k8s/, kubernetes/ - Kubernetes manifests (health probes, resource limits)
5. terraform/, pulumi/ - infrastructure as code
6. Makefile, Taskfile.yml, Justfile - look for deploy/release targets
7. deploy/, scripts/ - custom deploy scripts
8. package.json (scripts section), pyproject.toml - build/test/deploy commands
9. **Pre-deploy checklist files** - look for files with CHECKLIST, PRE_PROD, pre-deploy in name
10. **CLAUDE.md** - read for deploy rules, staging/prod procedures, deploy prohibitions
11. **Claude auto-memory** - compute encoded-path (replace non-alphanumeric chars in absolute project path with "-"), check if ~/.claude/projects/<encoded-path>/memory/ exists (ls first), if yes read .md files for deploy-related feedback

## What to extract

For STAGING deploy checklist:
- Test commands that must pass before staging deploy (from CI config)
- Build commands (compile, bundle, Docker build)
- Health check URL/command after deploy
- Smoke test commands

For PRODUCTION deploy checklist:
- Everything from staging, plus:
- Staging verification requirement
- Database migration safety (backward compatible?)
- Dependency audit (npm audit, pip-audit)
- Docker image tag verification (not :latest)
- Rollback procedure

## Output format

Output EXACTLY in this format (one block per checklist item):

###STAGING###
name: <item name>
command: <shell command to run>
expected: <"exit 0" or "contains:<text>">
required: <true or false>
###END###

###PRODUCTION###
name: <item name>
command: <shell command to run>
expected: <"exit 0" or "contains:<text>">
required: <true or false>
###END###

###SUMMARY###
[1-3 sentence summary of what was found]
###END###

Rules:
- Only propose items you can verify from actual project files
- Commands must be runnable from the project root
- Use actual test/build commands found in CI config, not generic ones
- If no deploy config found, output only the SUMMARY block saying so
===END===`;

export async function runDeployScan(opts: {
  projectPath: string;
  model?: string;
}): Promise<DeployScanResult> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const startTime = Date.now();
  const model = opts.model ?? "claude-haiku-4-5";

  const queryOpts = buildAgentQueryOptions(
    { cwd: opts.projectPath, model },
    "scanner",
  );

  const q = sdk.query({ prompt: DEPLOY_SCAN_PROMPT, options: queryOpts });

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

  const parsed = parseDeployScanOutput(result);
  if (!cost) cost = zeroCost();

  return { ...parsed, cost, durationMs: Date.now() - startTime };
}

export function parseDeployScanOutput(output: string): { stagingItems: ChecklistItem[]; prodItems: ChecklistItem[]; summary: string } {
  const stagingItems: ChecklistItem[] = [];
  const prodItems: ChecklistItem[] = [];
  let summary = "";

  for (const match of output.matchAll(/###STAGING###\n([\s\S]*?)###END###/g)) {
    const item = parseChecklistBlock(match[1]);
    if (item) stagingItems.push(item);
  }

  for (const match of output.matchAll(/###PRODUCTION###\n([\s\S]*?)###END###/g)) {
    const item = parseChecklistBlock(match[1]);
    if (item) prodItems.push(item);
  }

  const summaryMatch = output.match(/###SUMMARY###\n([\s\S]*?)###END###/);
  if (summaryMatch) summary = summaryMatch[1].trim();

  return { stagingItems, prodItems, summary };
}

function parseChecklistBlock(block: string): ChecklistItem | null {
  const get = (key: string): string => {
    const m = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };
  const name = get("name");
  const command = get("command");
  if (!name || !command) return null;
  return { name, command, expected: get("expected") || "exit 0", required: get("required") !== "false" };
}
