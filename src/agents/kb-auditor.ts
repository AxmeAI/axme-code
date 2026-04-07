/**
 * Knowledge Base Auditor — agent-based KB cleanup.
 *
 * Spawns a Claude agent with tools (Read, Grep, Glob, Agent) that:
 * 1. Reads all decisions from .axme-code/decisions/
 * 2. Finds duplicates and contradictions (using LLM judgment, not heuristics)
 * 3. Verifies against actual code which decision is current
 * 4. Updates storage files directly — supersedes outdated, removes true dupes
 * 5. Same for memories
 *
 * Two modes:
 * - Single repo: audit decisions + memories in one .axme-code/
 * - --all-repos: agent independently audits each repo (can use sub-agents to parallelize)
 */

import { DEFAULT_AUDITOR_MODEL } from "../types.js";
import { extractCostFromResult, type CostInfo } from "../utils/cost-extractor.js";
import { buildAgentQueryOptions } from "../utils/agent-options.js";

export interface KbAuditResult {
  decisionsReviewed: number;
  memoriesReviewed: number;
  superseded: number;
  revoked: number;
  questionsCreated: number;
  costUsd: number;
  durationMs: number;
}

const KB_AUDIT_PROMPT_SINGLE = `You are a knowledge base auditor for AXME Code.

Your task: clean up the .axme-code/ storage in the current project directory.

## Step 1: Audit decisions

1. Read the index file FIRST: ".axme-code/decisions/index.md" — it has a table of ALL decisions with id, title, enforce, source, date. This is ONE file read, not 75.
2. From the index, identify CANDIDATE pairs that look like duplicates or contradictions (same topic, similar titles).
3. ONLY THEN read the full decision files (D-NNN-slug.md) for those specific candidates to check body/reasoning.
4. For each candidate pair, determine if they are:
   a) DUPLICATES — same topic, different wording. Keep the newer one (by date field), supersede the older.
   b) CONTRADICTIONS — same topic, conflicting rules. Check the actual code (Read/Grep relevant files) to determine which is current. Supersede the outdated one.
   c) INDEPENDENT — different topics. Leave both.

3. To supersede a decision: edit the older file's frontmatter to add:
   status: superseded
   supersededBy: <newer decision id>
   Then edit the newer file to add:
   supersedes: <older decision id>

4. To revoke a decision (no longer applies per code evidence): edit its frontmatter to add:
   status: revoked
   revokedAt: <current ISO date>
   revokedReason: <why, based on code evidence>

## Step 2: Audit memories

1. Read all memory files: Glob ".axme-code/memory/feedback/*.md" and ".axme-code/memory/patterns/*.md"
2. Find duplicates (same advice, different wording) — delete the older file, keep the newer.
3. Find stale memories that contradict current code — delete them.

## Step 3: Compact all entries

For EVERY decision and memory file, rewrite to be more concise:

**Decisions**: the "decision" body must be 2-3 sentences containing WHAT was decided + WHY. Remove verbose reasoning that repeats the body. If "## Reasoning" section adds unique info not in body, merge it into body. Then clear the reasoning section.

**Memories**: the "description" field (line after # Title) must be 1-2 sentences containing the rule + specific action/command. If "## Details" section adds unique info not in description, merge it into description. Then remove the ## Details section.

Compact format rules:
- Keep all essential meaning — commands, specific values, error codes, concrete rules
- Remove filler words, narrative context, incident storytelling
- Do NOT remove: specific commands, file paths, error codes, concrete thresholds
- DO remove: "User said...", "Agent did X then Y then Z", step-by-step incident narrative
- Target: each entry readable as a standalone rule without needing context

## Rules

- ALWAYS check code before deciding which decision is current. Use Read/Grep to verify.
- When in doubt, keep both and move on. Only supersede/revoke when evidence is clear.
- Work through ALL decisions and memories systematically, not just a sample.
- After all changes, report what you did: how many superseded, revoked, deleted, compacted.
- Do NOT create new decisions or memories. Only clean up and compact existing ones.
`;

const KB_AUDIT_PROMPT_ALL_REPOS = `You are a knowledge base auditor for AXME Code workspace.

The workspace at the current directory contains multiple git repositories, each with its own .axme-code/ storage.

Your task: audit EACH repository's knowledge base independently.

## Process

1. List all subdirectories that have .axme-code/ (use Glob or ls)
2. For EACH repo, perform the full audit:
   a) Read .axme-code/decisions/index.md FIRST (one file per repo, has all decisions in a table). Only read individual D-NNN files for candidate pairs.
   b) Find duplicates and contradictions among decisions
   c) Check actual code in that repo to verify which decisions are current
   d) Supersede outdated decisions (edit frontmatter: add status: superseded, supersededBy)
   e) Revoke decisions that no longer apply (edit frontmatter: add status: revoked, revokedAt, revokedReason)
   f) Read all .axme-code/memory/feedback/*.md and .axme-code/memory/patterns/*.md
   g) Delete duplicate or stale memories
3. Also audit the workspace root .axme-code/ the same way

USE SUB-AGENTS (Agent tool) to parallelize — you can launch one agent per repo to work in parallel. Each sub-agent should:
- Work only within its assigned repo directory
- Follow the same audit rules below
- Report back what it changed

## Audit rules for each repo

- DUPLICATES: same topic different wording → keep newer (by date), supersede older
- CONTRADICTIONS: same topic conflicting content → Read/Grep code to determine current → supersede outdated
- STALE: decision/memory contradicts current code → revoke with evidence
- COMPACT: rewrite every decision body to 2-3 sentences (what+why). Rewrite every memory description to 1-2 sentences (rule+specific action). Merge Details/Reasoning sections into main field, then remove them.
- When in doubt, keep both. Only act on clear evidence.
- Do NOT create new decisions or memories. Only clean up and compact.

## After all repos done

Report summary: which repos had changes, how many decisions superseded/revoked/compacted, how many memories cleaned/compacted.
`;

/**
 * Run KB audit on a single repo or workspace.
 */
export async function runKbAudit(opts: {
  targetPath: string;
  allRepos: boolean;
  model?: string;
}): Promise<KbAuditResult> {
  const startTime = Date.now();
  const model = opts.model ?? DEFAULT_AUDITOR_MODEL;
  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  const prompt = opts.allRepos ? KB_AUDIT_PROMPT_ALL_REPOS : KB_AUDIT_PROMPT_SINGLE;

  const queryOpts = buildAgentQueryOptions(
    { cwd: opts.targetPath, model },
    "auditor",
  );

  const q = sdk.query({ prompt, options: queryOpts });

  let resultText = "";
  let cost: CostInfo | undefined;

  for await (const msg of q) {
    if (msg.type === "assistant") {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          // Stream thinking and text responses to stderr for visibility
          if (block.type === "thinking" && block.thinking) {
            process.stderr.write(`\x1b[2m[thinking] ${String(block.thinking).slice(0, 200)}...\x1b[0m\n`);
          }
          if (block.type === "text" && block.text) {
            resultText += block.text;
            process.stderr.write(`${block.text}\n`);
          }
        }
      }
    }
    if (msg.type === "result") {
      cost = extractCostFromResult(msg);
      if ((msg as any).subtype === "success" && (msg as any).result) {
        resultText = (msg as any).result;
      }
    }
  }

  // Parse agent's summary to extract counts
  const superseded = (resultText.match(/supersed/gi) || []).length;
  const revoked = (resultText.match(/revok/gi) || []).length;

  return {
    decisionsReviewed: 0, // agent handles internally
    memoriesReviewed: 0,
    superseded,
    revoked,
    questionsCreated: 0,
    costUsd: cost?.costUsd ?? 0,
    durationMs: Date.now() - startTime,
  };
}
