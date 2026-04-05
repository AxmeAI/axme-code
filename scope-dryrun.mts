/**
 * Scope routing dry-run.
 *
 * Loads a real Claude Code transcript, runs the production session auditor
 * (src/agents/session-auditor.ts) with the full workspace context, and prints
 * the extraction result. Does NOT call saveScopedMemories / saveScopedDecisions /
 * saveScopedSafetyRule — we only want to see what the LLM decided about scope.
 *
 * Usage:
 *   tsx scope-dryrun.mts <axme-session-id>
 */

import { existsSync, readFileSync } from "node:fs";
import { runSessionAudit } from "./src/agents/session-auditor.js";
import { parseAndRenderTranscript } from "./src/transcript-parser.js";
import { detectWorkspace } from "./src/utils/workspace-detector.js";
import { loadSession } from "./src/storage/sessions.js";

const WORKSPACE = "/home/georgeb/axme-workspace";
const TRANSCRIPTS_DIR = "/home/georgeb/.claude/projects/-home-georgeb-axme-workspace";

const sessionId = process.argv[2];
const modelArg = process.argv[3] || "claude-opus-4-6";
if (!sessionId) {
  console.error("Usage: tsx scope-dryrun.mts <axme-session-id> [model]");
  console.error("  model defaults to claude-opus-4-6");
  console.error("  examples: claude-opus-4-6 | claude-sonnet-4-6 | claude-haiku-4-5");
  process.exit(1);
}

const transcriptPath = `${TRANSCRIPTS_DIR}/${sessionId}.jsonl`;
if (!existsSync(transcriptPath)) {
  console.error(`Transcript not found: ${transcriptPath}`);
  process.exit(1);
}

// Detect workspace structure
const workspaceInfo = detectWorkspace(WORKSPACE);
console.log("=".repeat(70));
console.log("WORKSPACE STRUCTURE (passed to auditor)");
console.log("=".repeat(70));
console.log(`Type: ${workspaceInfo.type}`);
console.log(`Root: ${workspaceInfo.root}`);
console.log(`Projects (${workspaceInfo.projects.length}):`);
for (const p of workspaceInfo.projects.slice(0, 20)) {
  console.log(`  - ${p.name}  (path=${p.path})`);
}
if (workspaceInfo.projects.length > 20) {
  console.log(`  ... and ${workspaceInfo.projects.length - 20} more`);
}
console.log();

// Parse transcript
const parsed = parseAndRenderTranscript(transcriptPath);
console.log("=".repeat(70));
console.log("TRANSCRIPT STATS");
console.log("=".repeat(70));
console.log(`Raw: ${(parsed.rawSize / 1024).toFixed(1)} KB`);
console.log(`Filtered: ${(parsed.filteredSize / 1024).toFixed(1)} KB (${((parsed.filteredSize * 100) / parsed.rawSize).toFixed(1)}%)`);
console.log(`User turns: ${parsed.userTurns}`);
console.log(`Assistant turns: ${parsed.assistantTurns}`);
console.log(`Thinking: ${parsed.thinkingTurns}`);
console.log(`Tool use: ${parsed.toolUseTurns}`);
console.log(`Est tokens: ~${Math.round(parsed.filteredSize / 4)}`);
console.log();

// Load session meta if it exists (for filesChanged)
const session = loadSession(WORKSPACE, sessionId);
const filesChanged = session?.filesChanged ?? [];
console.log(`Files changed: ${filesChanged.length}`);
if (filesChanged.length > 0 && filesChanged.length <= 20) {
  for (const f of filesChanged) console.log(`  - ${f}`);
}
console.log();

// Run audit
console.log("=".repeat(70));
console.log(`RUNNING AUDIT (model=${modelArg}, Read/Grep/Glob, no budget cap)`);
console.log("=".repeat(70));

const start = Date.now();
const result = await runSessionAudit({
  sessionId,
  sessionOrigin: WORKSPACE,
  workspaceInfo,
  sessionTurns: parsed.turns,
  filesChanged,
  model: modelArg,
});
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log();
console.log("=".repeat(70));
console.log(`AUDIT RESULT  (${elapsed}s, $${result.cost.costUsd?.toFixed(4) ?? "?"})`);
console.log("=".repeat(70));
console.log(`Chunks: ${result.chunks ?? 1}  |  Total prompt tokens: ${result.promptTokens ?? "?"}`);
console.log();

console.log(`### MEMORIES (${result.memories.length}) ###`);
for (const m of result.memories) {
  console.log(`\n[${m.type}] ${m.title}`);
  console.log(`  slug: ${m.slug}`);
  console.log(`  scope: ${m.scope ? m.scope.join(", ") : "(none — defaults to session origin)"}`);
  console.log(`  description: ${m.description}`);
  console.log(`  → routes to: ${routeMemory(m, workspaceInfo)}`);
}

console.log(`\n\n### DECISIONS (${result.decisions.length}) ###`);
for (const d of result.decisions) {
  console.log(`\n${d.title}`);
  console.log(`  slug: ${d.slug}`);
  console.log(`  scope: ${d.scope ? d.scope.join(", ") : "(none — defaults to session origin)"}`);
  console.log(`  enforce: ${d.enforce ?? "null"}`);
  console.log(`  decision: ${d.decision.slice(0, 150)}${d.decision.length > 150 ? "..." : ""}`);
  console.log(`  → routes to: ${routeDecision(d, workspaceInfo)}`);
}

console.log(`\n\n### SAFETY (${result.safetyRules.length}) ###`);
for (const r of result.safetyRules) {
  console.log(`\n  ${r.ruleType}: ${r.value}`);
  console.log(`  scope: ${r.scope ? r.scope.join(", ") : "(none)"}`);
  console.log(`  → routes to: ${routeSafety(r, workspaceInfo)}`);
}

console.log(`\n\n### ORACLE ###`);
console.log(`  needs rescan: ${result.oracleNeedsRescan}`);

console.log(`\n\n### HANDOFF ###`);
if (result.handoff) {
  console.log(`  → writes to: ${WORKSPACE}/.axme-code/plans/handoff.md`);
  console.log(`  stopped_at: ${result.handoff.stoppedAt.slice(0, 150)}`);
  console.log(`  in_progress: ${result.handoff.inProgress.slice(0, 150)}`);
  console.log(`  blockers: ${result.handoff.blockers.slice(0, 150)}`);
  console.log(`  next: ${result.handoff.next.slice(0, 150)}`);
  console.log(`  dirty_branches: ${result.handoff.dirtyBranches.slice(0, 150)}`);
} else {
  console.log("  (no handoff)");
}

// --- Route simulators (mirror saveScoped* logic) ---

function routeMemory(m: any, ws: any): string {
  const scope = m.scope;
  if (!scope || scope.length === 0 || (scope.length === 1 && scope[0] === "all")) {
    return `${WORKSPACE}/.axme-code/memory/ (workspace-level "all")`;
  }
  const targets: string[] = [];
  for (const s of scope) {
    if (s === "all") continue;
    const absPath = `${WORKSPACE}/${s}`;
    if (existsSync(`${absPath}/.axme-code`) || existsSync(`${absPath}/.git`)) {
      targets.push(`${absPath}/.axme-code/memory/`);
    } else {
      targets.push(`[skip: ${s} does not exist]`);
    }
  }
  return targets.length > 0 ? targets.join(", ") : `${WORKSPACE}/.axme-code/memory/ (fallback: no repos matched)`;
}

function routeDecision(d: any, ws: any): string {
  const scope = d.scope;
  if (!scope || scope.length === 0 || (scope.length === 1 && scope[0] === "all")) {
    return `${WORKSPACE}/.axme-code/decisions/ (workspace-level "all")`;
  }
  const targets: string[] = [];
  for (const s of scope) {
    if (s === "all") continue;
    const absPath = `${WORKSPACE}/${s}`;
    if (existsSync(`${absPath}/.axme-code`) || existsSync(`${absPath}/.git`)) {
      targets.push(`${absPath}/.axme-code/decisions/`);
    } else {
      targets.push(`[skip: ${s} does not exist]`);
    }
  }
  return targets.length > 0 ? targets.join(", ") : `${WORKSPACE}/.axme-code/decisions/ (fallback)`;
}

function routeSafety(r: any, ws: any): string {
  const scope = r.scope;
  if (!scope || scope.length === 0 || (scope.length === 1 && scope[0] === "all")) {
    return `${WORKSPACE}/.axme-code/safety/rules.yaml (workspace-level)`;
  }
  const targets: string[] = [];
  for (const s of scope) {
    if (s === "all") continue;
    const absPath = `${WORKSPACE}/${s}`;
    if (existsSync(`${absPath}/.axme-code`) || existsSync(`${absPath}/.git`)) {
      targets.push(`${absPath}/.axme-code/safety/rules.yaml`);
    }
  }
  return targets.length > 0 ? targets.join(", ") : `${WORKSPACE}/.axme-code/safety/rules.yaml (fallback)`;
}
