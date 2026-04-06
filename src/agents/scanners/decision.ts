/**
 * Decision Scanner Agent - read-only LLM agent that extracts
 * architectural and design decisions from a project.
 *
 * Model: Sonnet
 * Tools: Read, Glob, Grep, Bash (read-only)
 * Budget: $1 max
 */

import type { Decision } from "../../types.js";
import { extractCostFromResult, zeroCost, type CostInfo } from "../../utils/cost-extractor.js";
import { buildAgentQueryOptions } from "../../utils/agent-options.js";
import { toSlug } from "../../storage/decisions.js";

export interface DecisionScanResult {
  decisions: Decision[];
  cost: CostInfo;
  durationMs: number;
}

const DECISION_SCAN_PROMPT = `You are a project analyst. Your job is to extract architectural and design decisions from this codebase.

## Instructions

Read the project's documentation and code to find decisions that were made about:
1. Technology choices (language, framework, database, message queue, cache) and WHY
2. Architecture patterns (monolith vs microservices, sync vs async, monorepo vs multi-repo) and WHY
3. API design decisions (REST vs GraphQL, response format, auth model, versioning) and WHY
4. Testing strategy (what framework, what's tested, what's mocked, coverage policy) and WHY
5. Deployment approach (where, how, CI/CD, staging vs prod, Docker, k8s) and WHY
6. Code organization (by feature, by layer, file structure conventions) and WHY
7. Error handling strategy (how errors are reported, logged, propagated) and WHY
8. Security decisions (auth model, secret management, access control) and WHY
9. Data management (migrations, schema approach, caching, retention) and WHY
10. Development workflow (branching, PR rules, release process) and WHY

**Where to look (check all that exist):**
- README.md - often explains why the project exists and key choices
- AI agent instruction files (HIGHEST PRIORITY - they encode critical decisions):
  - CLAUDE.md (root level) - read COMPLETELY
  - .claude/CLAUDE.md, .claude/rules/*.md, .claudecode/rules.md
  - AGENTS.md (cross-tool standard)
  - GEMINI.md, .cursorrules, .cursor/rules/*.mdc
  - .windsurfrules, .clinerules, .continuerules
  - .amazonq/rules/*.md, .junie/guidelines.md
  - .goosehints, .roo/rules/*.md, .augment/rules/*.md
  - **If CLAUDE.md references other files - follow those references and read them**
  - Check subdirectories for additional CLAUDE.md files
- Claude auto-memory (accumulated operational knowledge):
  - Compute encoded path: replace non-alphanumeric chars in absolute project path with "-"
  - Read ~/.claude/projects/<encoded-path>/memory/MEMORY.md
  - Read ALL .md files in ~/.claude/projects/<encoded-path>/memory/
  - These contain decisions made during real work - extract them
- Architecture Decision Records (docs/adr/, docs/decisions/, docs/architecture/decisions/, adr/)
- Architecture docs (docs/, ARCHITECTURE.md, DESIGN.md)
- RFCs and proposals (docs/rfcs/, docs/design/, docs/proposals/)
- Contributing guide (CONTRIBUTING.md)
- Comments in code that explain "why" not "what"
- Config files that reveal choices (Dockerfile, CI config, package manifest)
- Recent commit messages (git log --oneline -20)
- Deploy/checklist files (*CHECKLIST*, *PRE_PROD*) - contain deploy decisions

**Important:** Only extract REAL decisions you can find evidence for. Do not invent decisions. Each decision must have a clear "why" - if you can't find the reasoning, say "Reasoning not documented".

## Output Format

Produce your output in EXACTLY this format:

===DECISIONS===
###DECISION###
title: [short title, max 80 chars]
decision: [what was decided, 1-3 sentences]
reasoning: [why this choice was made, 1-3 sentences. "Reasoning not documented" if unknown]
enforce: [required OR advisory OR none]
###END###

[repeat for each decision found]

===END===

The "enforce" field indicates if this decision should be checked by a code reviewer:
- **required** = reviewer MUST flag violations (seen consistently 3+ times, enforced rule)
- **advisory** = reviewer should warn (general pattern with some exceptions)
- **none** = informational only, not enforced (historical context)

Find ALL decisions you can find evidence for. Do not limit the number. Cover all categories above where you find evidence. Prioritize decisions that are:
1. Explicitly documented (in README, CLAUDE.md, AGENTS.md, ADR files, comments)
2. Clearly visible in architecture (e.g., choice of database is evident from code)
3. Non-obvious (skip trivial decisions like "uses git" or "has a README")

Do NOT include:
- Trivial/obvious decisions ("project uses git", "has tests")
- Decisions you're guessing about with no evidence
- Duplicate decisions (if "uses PostgreSQL" and "uses SQLAlchemy" are the same decision, combine them)

CRITICAL DEDUP: If <existing_decisions> is provided below, it lists decisions already stored for this project (e.g. from presets). Do NOT extract any decision covering the SAME TOPIC as an existing one — even with different wording. Same topic = skip.
Examples: existing "All changes to main via PR" → skip "PR-only merges with checks". Existing "No destructive git ops" → skip "Never force-push".
If your version adds genuinely new details the existing lacks, extract it and note which existing ID it would supersede.`;

export async function runDecisionScan(opts: {
  projectPath: string;
  model?: string;
  /** Existing decisions (e.g. from presets) — scanner skips same-topic. */
  existingDecisions?: Decision[];
}): Promise<DecisionScanResult> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const startTime = Date.now();
  const model = opts.model ?? "claude-sonnet-4-6";

  const queryOpts = buildAgentQueryOptions(
    { cwd: opts.projectPath, model },
    "scanner",
  );

  let prompt = DECISION_SCAN_PROMPT;
  if (opts.existingDecisions && opts.existingDecisions.length > 0) {
    const list = opts.existingDecisions.map(d =>
      `- ${d.id}: ${d.title} [${d.enforce ?? "info"}] — ${d.decision}`
    ).join("\n");
    prompt += `\n\n<existing_decisions>\n${list}\n</existing_decisions>`;
  }

  const q = sdk.query({ prompt, options: queryOpts });

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

  const decisions = parseDecisionOutput(result);
  if (!cost) cost = zeroCost();

  return { decisions, cost, durationMs: Date.now() - startTime };
}

export function parseDecisionOutput(output: string): Decision[] {
  const decisions: Decision[] = [];
  const today = new Date().toISOString().slice(0, 10);

  let content = output;
  const startIdx = output.indexOf("===DECISIONS===");
  if (startIdx !== -1) {
    const endIdx = output.indexOf("===END===", startIdx);
    content = endIdx !== -1
      ? output.slice(startIdx + "===DECISIONS===".length, endIdx)
      : output.slice(startIdx + "===DECISIONS===".length);
  }

  const blocks = content.split("###DECISION###").filter(b => b.trim());
  let num = 1;

  for (const block of blocks) {
    const cleaned = block.replace(/###END###/g, "").trim();
    if (!cleaned) continue;

    const get = (key: string): string => {
      const m = cleaned.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      return m ? m[1].trim() : "";
    };

    const title = get("title");
    const decision = get("decision");
    const reasoning = get("reasoning");
    const enforceRaw = get("enforce").toLowerCase();
    const enforce = enforceRaw === "required" ? "required" as const
      : enforceRaw === "advisory" ? "advisory" as const : null;

    if (!title || !decision) continue;

    decisions.push({
      id: `D-${String(num++).padStart(3, "0")}`,
      slug: toSlug(title),
      title, decision,
      reasoning: reasoning || "Reasoning not documented",
      date: today, source: "init-scan", enforce, sessionId: null,
    });
  }

  return decisions;
}
