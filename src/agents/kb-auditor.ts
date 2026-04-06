/**
 * Knowledge Base Auditor — LLM-powered conflict detection and cleanup.
 *
 * Analyzes all active decisions + memories across workspace, compares
 * against code evidence (oracle), and finds:
 * - Conflicting decisions (two rules contradict each other)
 * - Stale decisions (code evidence contradicts the rule)
 * - Consolidation candidates (3+ decisions about the same topic)
 *
 * Returns structured findings that can be auto-applied (supersede/revoke)
 * or turned into open questions for user review.
 */

import type { Decision, Memory } from "../types.js";
import { DEFAULT_AUDITOR_MODEL } from "../types.js";
import { extractCostFromResult, type CostInfo } from "../utils/cost-extractor.js";

export interface KbAuditFinding {
  type: "conflict" | "stale" | "consolidate" | "question";
  /** Decision IDs involved. */
  ids: string[];
  /** Human-readable explanation. */
  description: string;
  /** Suggested resolution. */
  resolution: string;
  /** Confidence 0-1. Only findings >= 0.9 are auto-applied with --apply. */
  confidence: number;
  /** Suggested action if auto-applying. */
  action?: "supersede" | "revoke" | "consolidate" | "ask";
  /** For supersede: the new decision to create. */
  newDecision?: Partial<Decision>;
  /** For question: the question text. */
  question?: string;
}

export interface KbAuditResult {
  findings: KbAuditFinding[];
  totalDecisions: number;
  totalMemories: number;
  promptTokens: number;
  costUsd: number;
  durationMs: number;
}

const KB_AUDIT_PROMPT = `You are a knowledge base auditor for AXME Code, a development-lifecycle MCP server.

You are given the FULL list of active decisions and memories from a multi-project workspace, plus oracle summaries (stack, structure) of each project.

Your task: find problems in the knowledge base.

FIND THESE ISSUES:

1. CONFLICTS: Two or more active decisions that contradict each other.
   Example: D-012 says "use Redis for cache" but D-045 says "use Valkey for cache".

2. STALE: A decision that contradicts the current code evidence (from oracle).
   Example: D-019 says "Python 3.10" but oracle/stack.md shows "Python 3.13".

3. CONSOLIDATE: 3+ decisions that are about the same topic and should be merged into one.
   Example: D-031, D-044, D-067 all say slightly different things about deploy process.

4. QUESTIONS: Ambiguous situations where you cannot determine the right resolution
   without asking the user.

OUTPUT FORMAT (JSON array):
###FINDINGS###
[
  {
    "type": "conflict",
    "ids": ["D-012", "D-045"],
    "description": "D-012 says Redis, D-045 says Valkey for cache",
    "resolution": "Supersede D-012 with D-045 (D-045 is newer)",
    "confidence": 0.95,
    "action": "supersede"
  },
  {
    "type": "stale",
    "ids": ["D-019"],
    "description": "D-019 says Python 3.10 but oracle shows 3.13",
    "resolution": "Update D-019 to reflect Python 3.13",
    "confidence": 0.9,
    "action": "supersede",
    "newDecision": {
      "title": "Python 3.13 is the primary runtime version",
      "decision": "All services use Python 3.13",
      "reasoning": "Oracle evidence shows python:3.13 in CI and 3.11 in Dockerfile"
    }
  },
  {
    "type": "question",
    "ids": ["D-071"],
    "description": "D-071 says deploy only via workflow, unclear if hotfix PRs exempt",
    "resolution": "Ask user if hotfix PRs bypass workflow requirement",
    "confidence": 0.5,
    "action": "ask",
    "question": "Does D-071 'deploy only via workflow' apply to hotfix PRs with pre-approved label?"
  }
]
###END###

RULES:
- Only report REAL issues. If the knowledge base is clean, return an empty array.
- Be conservative with confidence. Only use >= 0.9 when the evidence is unambiguous.
- For CONFLICTS: the newer decision (by date) is usually correct. Suggest superseding the older.
- For STALE: oracle evidence is authoritative for technical facts (versions, frameworks, structure).
- Do not invent issues. If you are unsure, use type="question" with low confidence.
- Output ONLY the JSON array between ###FINDINGS### and ###END### markers. No other text.
`;

/**
 * Run LLM-powered KB audit on the workspace.
 */
export async function runKbAudit(opts: {
  decisions: Decision[];
  memories: Memory[];
  oracleByRepo: Array<{ repo: string; stack: string; structure: string }>;
  model?: string;
}): Promise<KbAuditResult> {
  const startTime = Date.now();
  const model = opts.model ?? DEFAULT_AUDITOR_MODEL;

  // Build context
  const decisionsList = opts.decisions.map(d =>
    `${d.id} [${d.enforce ?? "info"}] (${d.date}) ${d.title}: ${d.decision}`
  ).join("\n");

  const memoriesList = opts.memories.map(m =>
    `[${m.type}] ${m.title}: ${m.description}`
  ).join("\n");

  const oracleContext = opts.oracleByRepo.map(o =>
    `=== ${o.repo} ===\nStack: ${o.stack.slice(0, 500)}\nStructure: ${o.structure.slice(0, 300)}`
  ).join("\n\n");

  const userPrompt = [
    `<decisions count="${opts.decisions.length}">`,
    decisionsList,
    `</decisions>`,
    "",
    `<memories count="${opts.memories.length}">`,
    memoriesList,
    `</memories>`,
    "",
    `<oracle_evidence>`,
    oracleContext,
    `</oracle_evidence>`,
  ].join("\n");

  // Run LLM via Claude Agent SDK (same pattern as session-auditor)
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  let output = "";
  let promptTokens = 0;
  let costUsd = 0;

  const fullPrompt = KB_AUDIT_PROMPT + "\n\n" + userPrompt;
  process.stderr.write(
    `AXME kb-audit: prompt=${fullPrompt.length.toLocaleString()} chars (~${Math.round(fullPrompt.length / 4).toLocaleString()} tokens)\n`,
  );

  try {
    const q = sdk.query({
      prompt: fullPrompt,
      options: {
        model,
        systemPrompt: "You are a knowledge base auditor. Output ONLY the structured JSON between ###FINDINGS### and ###END### markers.",
        settingSources: [],
        mcpServers: {},
        permissionMode: "bypassPermissions" as const,
        allowDangerouslySkipPermissions: true,
        allowedTools: [],
        disallowedTools: ["Write", "Edit", "Bash", "Read", "Grep", "Glob", "Agent", "Skill", "TodoWrite", "WebFetch", "WebSearch", "NotebookEdit", "ToolSearch"],
        env: { ...process.env, AXME_SKIP_HOOKS: "1" },
      },
    });

    let cost: CostInfo | undefined;
    for await (const msg of q) {
      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) output += block.text;
          }
        }
      }
      if (msg.type === "result") {
        cost = extractCostFromResult(msg);
        if ((msg as any).subtype === "success" && (msg as any).result) {
          output = (msg as any).result;
        }
      }
    }
    if (cost) {
      promptTokens = cost.inputTokens ?? 0;
      costUsd = cost.costUsd ?? 0;
    }
  } catch (err) {
    process.stderr.write(`AXME kb-audit LLM error: ${err instanceof Error ? err.message : err}\n`);
    return {
      findings: [],
      totalDecisions: opts.decisions.length,
      totalMemories: opts.memories.length,
      promptTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // Parse findings
  const findings = parseFindingsOutput(output);

  return {
    findings,
    totalDecisions: opts.decisions.length,
    totalMemories: opts.memories.length,
    promptTokens,
    costUsd,
    durationMs: Date.now() - startTime,
  };
}

function parseFindingsOutput(output: string): KbAuditFinding[] {
  const match = output.match(/###FINDINGS###\s*([\s\S]*?)\s*###END###/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f: any) =>
      f.type && f.ids && Array.isArray(f.ids) && f.description
    );
  } catch {
    return [];
  }
}
