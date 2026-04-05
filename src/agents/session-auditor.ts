/**
 * Session Auditor Agent - post-session LLM analysis.
 *
 * Reads a filtered conversation transcript (produced by src/transcript-parser.ts)
 * and extracts:
 *   - Memories (feedback + patterns) — only direct user corrections or validated patterns
 *   - Decisions (policies/rules/constraints that cannot be recovered from the diff)
 *   - Safety rules (concrete command/path/branch rules from real incidents)
 *   - Oracle change detection
 *   - Handoff (session end state)
 *
 * Model: Opus 4.6 (stronger rule-following for strict "default-is-nothing" prompt)
 * Tools: Read, Grep, Glob (for de-dup verification against existing .axme-code/ storage).
 *        NO Bash — prevents the auditor from reading live repo state and polluting
 *        the handoff with the CURRENT state of the workspace instead of the
 *        state at the end of the audited session.
 * Budget: no cap (per project rule — see .axme-code/memory/feedback/no-llm-budget-caps.md)
 */

import type { Memory, Decision, SessionHandoff } from "../types.js";
import { extractCostFromResult, zeroCost, type CostInfo } from "../utils/cost-extractor.js";
import { toMemorySlug } from "../storage/memory.js";
import { toSlug, listDecisions } from "../storage/decisions.js";
import { listMemories } from "../storage/memory.js";

export interface SessionAuditResult {
  memories: Memory[];
  decisions: Omit<Decision, "id">[];
  safetyRules: Array<{ ruleType: string; value: string }>;
  oracleNeedsRescan: boolean;
  handoff: SessionHandoff | null;
  cost: CostInfo;
  durationMs: number;
}

const AUDIT_PROMPT = `You are auditing a Claude Code session transcript to extract ONLY knowledge that will be useful in FUTURE sessions and is NOT already available elsewhere.

You have read-only tools available (Read, Grep, Glob). Use them ONLY to verify whether an extraction candidate already exists in project storage. DO NOT read live repo state (working tree, current src/ file contents for "what is there now"). Your job is to extract knowledge FROM THE TRANSCRIPT, not to describe the current state of the repo.

The default answer for every category is "nothing". An empty section is the correct output for most sessions. Do not pad. Do not extract to look busy.

==== YOUR VALIDATION WORKFLOW ====

For EVERY candidate you consider extracting, run this check against .axme-code/ storage only:

1. MEMORY candidate (feedback/pattern): Grep .axme-code/memory/ for the key phrase. If a similar memory exists, REJECT.
2. DECISION candidate: Grep .axme-code/decisions/ for the key term. If already recorded, REJECT. Also verify the decision is a policy/principle/constraint that cannot be inferred by reading the diff that would result from this session (you do NOT need to read the actual diff — just ask yourself: "if someone reads the PR diff, can they recover this principle from the code alone?").
3. SAFETY candidate: Grep .axme-code/safety/ to confirm it is new.

Budget: read up to 15 files total. Reject fast. DO NOT read src/ or other repo code to verify candidates — that tells you what the repo looks like TODAY, not what was decided in this session. Trust the transcript for session events, use .axme-code/ only for dedup.

HANDOFF SECTION NOTE: the handoff must describe the state AT THE END OF THE SESSION (based on the transcript), not the CURRENT state of the repo. Never read working tree or git status to fill handoff — those reflect later sessions, not this one.

==== EXTRACTION CATEGORIES ====

MEMORIES (type=feedback)
Extract ONLY when the user explicitly corrected the agent, expressed a strong preference, or reacted negatively. Watch for: "don't", "stop", "always", "never", "no, wrong", user questioning agent's action, frustration, surprise. Also catch non-English equivalents (e.g. Russian "нельзя", "не надо", "всегда", "никогда", "неправильно", "сколько раз говорил").
Required fields: what agent was doing, what user asked for instead, THE USER'S STATED REASON (if no reason was given, still extract but mark the Why as "user did not explain").

MEMORIES (type=pattern)
Extract ONLY when a non-obvious technique was discovered through trial and error AND the user explicitly validated it worked. NOT "we built feature X" — features are in the code.

DECISIONS
Extract ONLY if BOTH:
(a) The decision is NOT visible in the resulting code/config/diff — someone reading the code cannot recover the reasoning or the rule.
(b) The user explicitly stated it as a rule/policy/constraint in the transcript, OR the user agreed to a proposed rule/policy/constraint.

REJECT:
- "We added feature X because Y" — feature is in the code
- "Use X instead of Y" — both visible in diff
- "Changed approach from A to B" — git log has this
- "User confirmed implementation Z" — implementation is in the code

ACCEPT:
- Process rules the user stated: "never merge without staging check"
- Policy constraints: "no direct pushes to main"
- Accepted trade-offs: "we accept this limitation for now"
- Negative rules: "do not write to X"

SAFETY
Extract ONLY if a new bash_deny/bash_allow/fs_deny/git_protected_branch rule was produced from a real signal (user said so, or an incident happened in this session).

HANDOFF
Restate session state with specifics based on the transcript alone. This section does NOT require novelty.
- stopped_at: exact task/file at end of session
- in_progress: branch names, PR numbers, uncommitted work
- blockers: concrete blockers with enough detail to resume
- next: concrete next steps (file paths, commands)
- dirty_branches: branch names with state

==== OUTPUT LANGUAGE ====

All output fields (title, description, keywords, body, reasoning, handoff fields) MUST be in English. Even if the transcript is in another language (Russian, etc.), write the extraction in English. Non-English user quotes may be embedded inline as evidence with quotation marks, but the surrounding explanation must be English. This is a hard requirement.

==== OUTPUT FORMAT ====

Use these exact markers. Empty sections MUST still include the header with nothing between markers.

###MEMORIES###
slug: <kebab-case, max 60 chars>
type: <feedback | pattern>
title: <English, max 80 chars>
description: <English, 1-2 sentences>
keywords: <English, 3-7 comma-separated>
scope: <project name or "all">
body: <English. Include **Why:** and **How to apply:** lines. Non-English quotes OK inline as evidence>
---
###END###

###DECISIONS###
title: <English, max 80 chars>
decision: <English, what was decided>
reasoning: <English, with specifics from the session>
enforce: <required | advisory | none>
---
###END###

###SAFETY###
rule_type: <bash_deny | bash_allow | fs_deny | git_protected_branch>
value: <specific command/path/branch>
---
###END###

###ORACLE_CHANGES###
YES or NO with 1 English sentence if YES
###END###

###HANDOFF###
stopped_at: <English>
in_progress: <English>
blockers: <English>
next: <English>
dirty_branches: <English>
###END###

REMEMBER: Use your tools to verify every candidate before extracting. Empty is correct. All output English.`;

/**
 * Build the "existing knowledge" context block that prevents duplicate extractions.
 * We give the auditor a compact list of titles + short snippets so it can dedup
 * without needing to Grep every file.
 */
function buildExistingContext(projectPath: string): string {
  const parts: string[] = [];

  try {
    const decisions = listDecisions(projectPath);
    if (decisions.length > 0) {
      const lines = decisions.map(d => `- ${d.title}: ${d.decision.slice(0, 120)}`);
      parts.push("## Existing decisions (DO NOT re-extract these)\n" + lines.join("\n"));
    }
  } catch {}

  try {
    const memories = listMemories(projectPath);
    if (memories.length > 0) {
      const lines = memories.map(m => `- [${m.type}] ${m.title}: ${m.description}`);
      parts.push("## Existing memories (DO NOT re-extract these)\n" + lines.join("\n"));
    }
  } catch {}

  return parts.join("\n\n");
}

/**
 * Run full session audit — extracts memories, decisions, safety rules, oracle changes, handoff.
 *
 * @param opts.sessionTranscript - Filtered conversation text from a Claude Code
 *   transcript (see transcript-parser.ts). Preferred input.
 * @param opts.sessionEvents - Fallback: worklog events joined as text. Used when
 *   no Claude Code transcript is attached to the session.
 */
export async function runSessionAudit(opts: {
  sessionId: string;
  sessionTranscript?: string;
  sessionEvents?: string;
  filesChanged: string[];
  projectPath: string;
}): Promise<SessionAuditResult> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const startTime = Date.now();

  const queryOpts = {
    cwd: opts.projectPath,
    model: "claude-opus-4-6",
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    allowedTools: ["Read", "Grep", "Glob"],
    disallowedTools: ["Write", "Edit", "NotebookEdit", "Agent", "Skill", "TodoWrite", "WebFetch", "WebSearch", "Bash"],
  };

  const existingContext = buildExistingContext(opts.projectPath);
  const conversationSource = opts.sessionTranscript ?? opts.sessionEvents ?? "";
  const conversationLabel = opts.sessionTranscript
    ? "==== SESSION TRANSCRIPT (filtered conversation) ===="
    : "==== SESSION WORKLOG EVENTS (transcript unavailable) ====";

  const contextLines = [
    AUDIT_PROMPT,
    "",
    "==== EXISTING PROJECT KNOWLEDGE (verify your extractions are NEW vs this) ====",
    "",
    existingContext || "(none)",
    "",
    `Files changed in this session (${opts.filesChanged.length}): ${opts.filesChanged.slice(0, 30).join(", ")}`,
    "",
    conversationLabel,
    "",
    conversationSource,
  ];

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
