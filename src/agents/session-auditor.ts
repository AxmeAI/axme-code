/**
 * Session Auditor Agent - post-session LLM analysis.
 *
 * Extracts ALL storage module updates from a session:
 * - Memories (feedback + patterns)
 * - Decisions (new architectural decisions)
 * - Safety rules (new constraints)
 * - Oracle change detection (does structure/stack need re-scan?)
 *
 * Model: Sonnet (needs deeper understanding for decision extraction)
 * Budget: $0.30
 */

import type { Memory, Decision, SessionHandoff } from "../types.js";
import { extractCostFromResult, zeroCost, type CostInfo } from "../utils/cost-extractor.js";
import { toMemorySlug } from "../storage/memory.js";
import { toSlug } from "../storage/decisions.js";

export interface SessionAuditResult {
  memories: Memory[];
  decisions: Omit<Decision, "id">[];
  safetyRules: Array<{ ruleType: string; value: string }>;
  oracleNeedsRescan: boolean;
  handoff: SessionHandoff | null;
  cost: CostInfo;
  durationMs: number;
}

const AUDIT_PROMPT = `You are a session auditor. Analyze this coding session and extract everything useful for future sessions.

Extract ALL of the following categories. If a category has nothing to extract, output the section header with nothing inside.

###MEMORIES###
For each error pattern (feedback) or successful approach (pattern):

slug: <kebab-case, max 60 chars>
type: <feedback or pattern>
title: <one-line summary, max 80 chars>
description: <1-2 sentence explanation>
keywords: <3-7 keywords, comma-separated>
scope: <project name, or "all" for universal>
body: <explanation with **Why:** and **How to apply:**>

---

###END###

###DECISIONS###
For each new architectural decision made or discovered:

title: <short title, max 80 chars>
decision: <what was decided, 1-3 sentences>
reasoning: <why, 1-3 sentences>
enforce: <required OR advisory OR none>

---

###END###

###SAFETY###
For each new safety constraint discovered:

rule_type: <bash_deny OR bash_allow OR fs_deny OR git_protected_branch>
value: <the command/path/branch>

---

###END###

###ORACLE_CHANGES###
Did the project structure or stack change significantly in this session?
Answer YES or NO.
If YES, briefly describe what changed (new directories, new dependencies, renamed files).
###END###

###HANDOFF###
Summarize what the next session needs to know to continue this work:

stopped_at: <what was the agent working on when session ended, or "nothing" if clean>
in_progress: <what tasks/PRs/branches are mid-work, or "none">
blockers: <any blockers or issues discovered, or "none">
next: <concrete next steps, or "none">
dirty_branches: <git branches with uncommitted or unpushed work, or "none">
###END###

Rules:
- Only extract things useful in FUTURE sessions
- Skip trivial or one-off issues
- Be specific, not generic
- For decisions: only real decisions with evidence, not guesses
- For safety: only rules that should be enforced going forward
- For oracle: YES only if structure/stack actually changed (new dirs, new deps, major refactors)

===END===`;

/**
 * Run full session audit - extracts memories, decisions, safety rules, oracle changes.
 */
export async function runSessionAudit(opts: {
  sessionId: string;
  sessionEvents: string;
  filesChanged: string[];
  projectPath: string;
  oracleSummary?: string;
  decisionsCount?: number;
}): Promise<SessionAuditResult> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const startTime = Date.now();

  const queryOpts = {
    cwd: opts.projectPath,
    model: "claude-sonnet-4-6",
    maxBudgetUsd: 0.30,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    allowedTools: [] as string[],
    disallowedTools: ["Write", "Edit", "Bash", "Glob", "Grep", "Read", "Agent", "NotebookEdit", "Skill", "TodoWrite"],
  };

  const contextLines = [
    AUDIT_PROMPT,
    "",
    `Session ID: ${opts.sessionId}`,
    `Files changed (${opts.filesChanged.length}): ${opts.filesChanged.slice(0, 30).join(", ")}`,
    opts.oracleSummary ? `Current oracle summary: ${opts.oracleSummary}` : "",
    opts.decisionsCount !== undefined ? `Current decisions: ${opts.decisionsCount}` : "",
    "",
    "Session transcript:",
    opts.sessionEvents,
  ].filter(Boolean);

  const q = sdk.query({ prompt: contextLines.join("\n"), options: queryOpts });

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

  const parsed = parseAuditOutput(result, opts.sessionId);
  if (!cost) cost = zeroCost();

  return { ...parsed, cost, durationMs: Date.now() - startTime };
}

/**
 * Parse audit output into structured results.
 */
export function parseAuditOutput(output: string, sessionId: string): Omit<SessionAuditResult, "cost" | "durationMs"> {
  const today = new Date().toISOString().slice(0, 10);

  // Parse memories
  const memories: Memory[] = [];
  const memoriesSection = extractSection(output, "MEMORIES");
  if (memoriesSection) {
    for (const block of memoriesSection.split("---").filter(b => b.trim())) {
      const get = (key: string) => getField(block, key);
      const slug = toMemorySlug(get("slug"));
      const type = get("type");
      const title = get("title");
      if (!slug || !title || (type !== "feedback" && type !== "pattern")) continue;

      const keywordsRaw = get("keywords");
      const scopeRaw = get("scope");
      const bodyMatch = block.match(/^body:\s*([\s\S]*)$/m);

      memories.push({
        slug, type: type as "feedback" | "pattern", title,
        description: get("description"),
        keywords: keywordsRaw ? keywordsRaw.split(",").map(k => k.trim()).filter(Boolean) : [],
        source: "session", sessionId, date: today,
        body: bodyMatch ? bodyMatch[1].trim() : "",
        ...(scopeRaw && scopeRaw !== "all" ? { scope: scopeRaw.split(",").map(s => s.trim()).filter(Boolean) } : {}),
        ...(scopeRaw === "all" ? { scope: ["all"] } : {}),
      });
    }
  }

  // Parse decisions
  const decisions: Omit<Decision, "id">[] = [];
  const decisionsSection = extractSection(output, "DECISIONS");
  if (decisionsSection) {
    for (const block of decisionsSection.split("---").filter(b => b.trim())) {
      const get = (key: string) => getField(block, key);
      const title = get("title");
      const decision = get("decision");
      if (!title || !decision) continue;

      const enforceRaw = get("enforce").toLowerCase();
      decisions.push({
        slug: toSlug(title), title, decision,
        reasoning: get("reasoning") || "Extracted from session",
        date: today, source: "session",
        enforce: enforceRaw === "required" ? "required" : enforceRaw === "advisory" ? "advisory" : null,
        sessionId,
      });
    }
  }

  // Parse safety rules
  const safetyRules: Array<{ ruleType: string; value: string }> = [];
  const safetySection = extractSection(output, "SAFETY");
  if (safetySection) {
    for (const block of safetySection.split("---").filter(b => b.trim())) {
      const ruleType = getField(block, "rule_type");
      const value = getField(block, "value");
      if (ruleType && value) safetyRules.push({ ruleType, value });
    }
  }

  // Parse oracle changes
  let oracleNeedsRescan = false;
  const oracleSection = extractSection(output, "ORACLE_CHANGES");
  if (oracleSection && oracleSection.trim().toUpperCase().startsWith("YES")) {
    oracleNeedsRescan = true;
  }

  // Parse handoff
  let handoff: SessionHandoff | null = null;
  const handoffSection = extractSection(output, "HANDOFF");
  if (handoffSection) {
    const stoppedAt = getField(handoffSection, "stopped_at");
    const inProgress = getField(handoffSection, "in_progress");
    const blockers = getField(handoffSection, "blockers");
    const next = getField(handoffSection, "next");
    const dirtyBranches = getField(handoffSection, "dirty_branches");
    const hasContent = [stoppedAt, inProgress, next].some(v => v && v !== "none" && v !== "nothing");
    if (hasContent) {
      handoff = { stoppedAt, inProgress, blockers, next, dirtyBranches };
    }
  }

  return { memories, decisions, safetyRules, oracleNeedsRescan, handoff };
}

function extractSection(output: string, name: string): string | null {
  const startMarker = `###${name}###`;
  const endMarker = "###END###";
  const startIdx = output.indexOf(startMarker);
  if (startIdx === -1) return null;
  const contentStart = startIdx + startMarker.length;
  const endIdx = output.indexOf(endMarker, contentStart);
  if (endIdx === -1) return output.slice(contentStart).trim();
  return output.slice(contentStart, endIdx).trim();
}

function getField(block: string, key: string): string {
  const m = block.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? m[1].trim() : "";
}
