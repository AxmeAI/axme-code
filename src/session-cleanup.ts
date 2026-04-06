/**
 * Shared session cleanup logic — runs LLM audit and closes a session.
 *
 * Used by three entry points:
 * 1. MCP server transport close handler (auto-audit on disconnect)
 * 2. MCP server startup fallback (orphaned sessions from killed processes)
 * 3. SessionEnd hook (if Claude Code fires it — rare but supported)
 *
 * All three paths set `auditedAt` on success so subsequent paths skip the
 * same session. This dedup is the single source of truth for "has audit run?".
 */

import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { readWorklog, logSessionEnd, logError, logAuditComplete, logCheckResult } from "./storage/worklog.js";
import { saveScopedMemories, listMemories } from "./storage/memory.js";
import { saveScopedDecisions, listDecisions, supersedeDecision, getDecision } from "./storage/decisions.js";
import { saveScopedSafetyRule, loadSafetyRules, type SafetyRuleType } from "./storage/safety.js";
import { writeOracleFiles } from "./storage/oracle.js";
import { writeHandoff } from "./storage/plans.js";
import {
  closeSession,
  loadSession,
  markAudited,
  writeSession,
  writeAuditLog,
  updateAuditLog,
  readAuditedOffset,
  writeAuditedOffset,
  AUDIT_STALE_TIMEOUT_MS,
  MAX_AUDIT_ATTEMPTS,
  isRetryableError,
  RETRYABLE_MAX_ATTEMPTS,
  type AuditLog,
  type AuditLogExtraction,
  type AuditLogResumeInfo,
} from "./storage/sessions.js";
import { pathExists } from "./storage/engine.js";
import { parseAndRenderTranscripts } from "./transcript-parser.js";
import { detectWorkspace } from "./utils/workspace-detector.js";
import { readConfig } from "./storage/config.js";
import { AXME_CODE_DIR } from "./types.js";

/**
 * Resolve where a scoped item will actually be stored, for audit log reporting.
 * Mirrors the routing logic of saveScopedMemories / saveScopedDecisions /
 * saveScopedSafetyRule so the audit log shows the TRUE destinations.
 */
function resolveScopeRoutes(
  scope: string[] | undefined,
  workspacePath: string,
  workspaceRoot?: string,
): string[] {
  const isAll = !scope || scope.length === 0 || (scope.length === 1 && scope[0] === "all");
  if (isAll) return [workspacePath];
  if (!workspaceRoot) return [workspacePath];
  const repos: string[] = [];
  for (const s of scope!) {
    if (s === "all") continue;
    const abs = join(workspaceRoot, s);
    if (pathExists(join(abs, ".axme-code")) || pathExists(join(abs, ".git"))) {
      repos.push(abs);
    }
  }
  return repos.length > 0 ? repos : [workspacePath];
}

/**
 * Snapshot existing memory/decision slugs at each routing target so we can
 * detect per-item whether saveScoped wrote a new file or overwrote an existing
 * one (slug-level dedup).
 */
function snapshotExistingSlugs(paths: string[]): {
  memories: Record<string, Set<string>>;
  decisions: Record<string, Set<string>>;
} {
  const memories: Record<string, Set<string>> = {};
  const decisions: Record<string, Set<string>> = {};
  for (const p of paths) {
    try { memories[p] = new Set(listMemories(p).map(m => m.slug)); } catch { memories[p] = new Set(); }
    try { decisions[p] = new Set(listDecisions(p).map(d => d.slug)); } catch { decisions[p] = new Set(); }
  }
  return { memories, decisions };
}

/**
 * Record an audit failure on the session: set auditStatus=failed, save
 * lastAuditError, log to worklog, write to stderr. Silent swallow is an
 * anti-pattern.
 *
 * Note: auditAttempts is bumped earlier (in the pre-audit check-and-set step)
 * rather than here, so a crashed auditor counts against the retry cap even
 * if this failure handler never runs.
 */
function recordAuditFailure(
  workspacePath: string,
  sessionId: string,
  err: unknown,
  phase: string,
): void {
  const errMsg = err instanceof Error ? err.message : String(err);
  const errStack = err instanceof Error ? err.stack : undefined;
  const retryable = isRetryableError(errMsg);

  try {
    const s = loadSession(workspacePath, sessionId);
    if (s) {
      const attempts = s.auditAttempts ?? 0;
      if (retryable && attempts < RETRYABLE_MAX_ATTEMPTS) {
        // Transient error: leave as stale-pending so orphan scan retries.
        // Set auditStartedAt far enough in the past to exceed the stale
        // timeout, so the next findOrphanSessions cycle picks it up.
        s.auditStatus = "pending";
        s.auditStartedAt = new Date(Date.now() - AUDIT_STALE_TIMEOUT_MS - 60_000).toISOString();
        s.lastAuditError = `[${phase}] (retryable ${attempts + 1}/${RETRYABLE_MAX_ATTEMPTS}) ${errMsg}`;
        process.stderr.write(
          `AXME audit: retryable error for ${sessionId} (attempt ${attempts + 1}/${RETRYABLE_MAX_ATTEMPTS}): ${errMsg}\n`,
        );
      } else {
        // Deterministic failure or retryable max reached: mark as failed permanently.
        s.auditStatus = "failed";
        s.lastAuditError = `[${phase}] ${errMsg}`;
        s.auditFinishedAt = new Date().toISOString();
      }
      writeSession(workspacePath, s);
    }
  } catch {
    // Secondary failure writing the error record itself — nothing else we can do.
  }
  try {
    logError(workspacePath, sessionId, `audit failed (${phase}): ${errMsg}`);
  } catch {}
  if (!retryable) {
    process.stderr.write(`AXME audit failed (${phase}) for ${sessionId}: ${errStack ?? errMsg}\n`);
  }
}

export interface SessionCleanupResult {
  sessionId: string;
  auditRan: boolean;
  memories: number;
  decisions: number;
  safetyRules: number;
  handoffSaved: boolean;
  worklogSummary: boolean;
  oracleRescanned: boolean;
  costUsd: number;
  skipped?: "already-audited" | "not-found" | "no-storage" | "concurrent-audit" | "retry-cap" | "ghost";
}

/**
 * Run full session cleanup: LLM audit + save artifacts + close session.
 *
 * Idempotent: if the session is already audited (`auditedAt` set), returns
 * early with `skipped: "already-audited"` and does nothing.
 *
 * If the session has insufficient activity (worklog events shorter than 50
 * chars), skips the LLM audit but still closes the session cleanly.
 *
 * @param workspacePath - Absolute path to the AXME workspace/project root
 * @param sessionId - UUID of the AXME session to audit and close
 */
export async function runSessionCleanup(
  workspacePath: string,
  sessionId: string,
): Promise<SessionCleanupResult> {
  const base: SessionCleanupResult = {
    sessionId,
    auditRan: false,
    memories: 0,
    decisions: 0,
    safetyRules: 0,
    handoffSaved: false,
    worklogSummary: false,
    oracleRescanned: false,
    costUsd: 0,
  };

  if (!pathExists(join(workspacePath, AXME_CODE_DIR))) {
    return { ...base, skipped: "no-storage" };
  }

  const session = loadSession(workspacePath, sessionId);
  if (!session) {
    return { ...base, skipped: "not-found" };
  }

  // Ghost detection: sessions with 0 filesChanged and <2s lifetime are artifacts
  // from subclaude hook fires (Bug F) or race conditions. Skip LLM audit entirely
  // and mark as done. Saves LLM cost on empty sessions.
  const isGhost =
    session.filesChanged.length === 0 &&
    session.closedAt && session.createdAt &&
    (Date.parse(session.closedAt) - Date.parse(session.createdAt)) < 2000;
  if (isGhost) {
    markAudited(workspacePath, sessionId);
    return { ...base, skipped: "ghost" };
  }

  // Dedup 1: if audit already ran, don't repeat. Just ensure session is closed.
  if (session.auditedAt) {
    if (!session.closedAt) closeSession(workspacePath, sessionId);
    return { ...base, skipped: "already-audited" };
  }

  // Dedup 2: concurrent-audit protection. If another auditor is mid-run on
  // this session (auditStatus=pending within the stale timeout), skip — the
  // other auditor will handle it. saveScopedMemories/saveScopedDecisions
  // already dedup by slug, so the worst case even if both audits completed
  // in parallel would be wasted LLM cost, not data corruption. Stale
  // "pending" state (older than AUDIT_STALE_TIMEOUT_MS) is ignored: it
  // indicates a crashed / SIGKILLed auditor and we allow a retry to proceed.
  let currentAttempts = session.auditAttempts ?? 0;
  if (session.auditStatus === "pending" && session.auditStartedAt) {
    const startedMs = Date.parse(session.auditStartedAt);
    const ageMs = Date.now() - startedMs;
    if (Number.isFinite(startedMs) && ageMs < AUDIT_STALE_TIMEOUT_MS) {
      return { ...base, skipped: "concurrent-audit" };
    }
    // Stale pending → previous attempt was killed (SIGKILL on VS Code window
    // close, OOM, reboot, crash). That is NOT a deterministic failure, so
    // the retry cap below must not apply — reset auditAttempts in memory so
    // the fresh attempt can proceed. The retry cap still protects against
    // real repeated failures (where auditStatus would be "failed", not
    // "pending" + stale).
    process.stderr.write(
      `AXME audit: stale pending for ${sessionId} (age=${Math.round(ageMs / 60000)} min), resetting auditAttempts to allow retry\n`,
    );
    currentAttempts = 0;
    session.auditAttempts = 0;
  }

  // Dedup 3: retry cap. If the session already used up its audit attempts
  // and still has no auditedAt, do NOT retry — it either hit a deterministic
  // failure (too-large prompt, parser rejection) or a bug that needs manual
  // inspection. Silent endless retries hide real problems.
  if (currentAttempts >= MAX_AUDIT_ATTEMPTS) {
    return { ...base, skipped: "retry-cap" };
  }

  let filesChanged = session.filesChanged ?? [];

  // Prefer the Claude Code transcript (filtered conversation turns) over the
  // worklog when available. Transcripts contain the actual user/assistant
  // dialog with reasoning, corrections, and agreements — exactly what the
  // auditor needs. The worklog only has sparse structural events.
  //
  // We pass sessionTurns (structured) to the auditor so it can chunk the
  // transcript at turn boundaries for long sessions. sessionTranscript (the
  // pre-rendered string) is only used as a display fallback.
  const claudeSessions = session.claudeSessions ?? [];
  let sessionTurns: import("./transcript-parser.js").ConversationTurn[] | undefined;
  // Resume-audit optimization: for each attached Claude session, look up the
  // byte offset that the previous audit reached. The parser then reads the
  // transcript jsonl starting at that offset, and downstream the auditor
  // only sees turns that were NOT yet captured in the knowledge base. After
  // a successful audit we persist the new end offsets via writeAuditedOffset
  // so the next resume continues where this one left off.
  const startOffsets: Record<string, number> = {};
  for (const ref of claudeSessions) {
    startOffsets[ref.id] = readAuditedOffset(workspacePath, ref.id);
  }
  let newEndOffsets: Record<string, number> = {};
  let bytesReadPerRef: Record<string, number> = {};
  if (claudeSessions.length > 0) {
    const parsed = parseAndRenderTranscripts(claudeSessions, startOffsets);
    newEndOffsets = parsed.endOffsets;
    bytesReadPerRef = parsed.bytesRead;
    if (parsed.allTurns.length > 0) {
      sessionTurns = parsed.allTurns;
    }
    // Supplement filesChanged with file paths extracted from Bash tool_use
    // commands in the transcript. PostToolUse hook only tracks Edit/Write/
    // NotebookEdit — Bash mutations (echo > file, sed -i, cp, mv, rm) are
    // invisible without this supplementation.
    if (parsed.allBashCommands.length > 0) {
      const { extractBashWritePaths } = await import("./utils/bash-file-extract.js");
      const bashPaths = new Set<string>();
      for (const cmd of parsed.allBashCommands) {
        for (const p of extractBashWritePaths(cmd)) bashPaths.add(p);
      }
      let added = 0;
      for (const p of bashPaths) {
        if (!session.filesChanged.includes(p)) {
          session.filesChanged.push(p);
          added++;
        }
      }
      if (added > 0) {
        filesChanged = session.filesChanged;
        writeSession(workspacePath, session);
        process.stderr.write(
          `AXME audit ${sessionId}: +${added} files from Bash commands\n`,
        );
      }
    }
    // Observability: log how many bytes were skipped because they were
    // already audited. Useful to confirm the resume optimization is
    // actually firing when expected.
    for (const ref of claudeSessions) {
      const from = startOffsets[ref.id] ?? 0;
      const to = newEndOffsets[ref.id] ?? from;
      if (from > 0) {
        process.stderr.write(
          `AXME audit ${sessionId}: resume from offset ${from} for Claude ${ref.id.slice(0, 8)} ` +
            `(${bytesReadPerRef[ref.id] ?? 0} new bytes, end=${to})\n`,
        );
      }
    }
  }

  // Fallback: if no transcript is attached (pre-transcript-audit sessions, or
  // a session that ended before any hook fired), use the worklog events.
  let sessionEvents: string | undefined;
  if (!sessionTurns) {
    const events = readWorklog(workspacePath, { limit: 500 });
    sessionEvents = events
      .filter(e => e.sessionId === sessionId)
      .reverse()
      .map(e => `[${e.timestamp}] ${e.type}: ${JSON.stringify(e.data)}`)
      .join("\n");
  }

  const result: SessionCleanupResult = { ...base };
  let auditSucceeded = false;
  const activityLength = sessionTurns
    ? sessionTurns.reduce((s, t) => s + t.content.length, 0)
    : (sessionEvents ?? "").length;
  // filesChanged > 0 forces audit even without transcript — covers the scenario
  // where hooks tracked file edits but the session closed before a Claude
  // transcript was attached (e.g. early SIGKILL, no ensureAxmeSessionForClaude).
  const hasActivity = activityLength > 50 || filesChanged.length > 0;

  // Detect whether the session was opened at a workspace root or a single repo.
  // This determines scope routing (per-repo vs workspace-level) for all writes.
  const workspaceInfo = detectWorkspace(workspacePath);
  const isWorkspaceSession = workspaceInfo.type !== "single";
  const workspaceRoot = isWorkspaceSession ? workspacePath : undefined;

  // Read audit model from config (falls back to DEFAULT_AUDITOR_MODEL if config
  // file is missing or the auditor_model field is not set).
  const config = readConfig(workspacePath);

  // Run LLM audit only if there's meaningful activity to analyze
  if (hasActivity) {
    const auditStartIso = new Date().toISOString();
    const auditStartMs = Date.now();

    // Claim the audit for this process by setting auditStatus=pending in a
    // single writeSession call. This is not an atomic lock — two processes
    // could both read auditStatus!=pending and both enter here — but that
    // race is accepted: saveScopedMemories/saveScopedDecisions dedup by slug,
    // so parallel audits waste money rather than corrupt data. Reading
    // axme_context via listPendingAudits will still show the most recent
    // auditor (the one whose write landed last).
    //
    // auditAttempts is incremented here (before the LLM call) rather than in
    // recordAuditFailure: a crashed auditor must still count against the
    // retry cap even if the finally block never runs.
    session.auditStatus = "pending";
    session.auditStartedAt = auditStartIso;
    session.auditAttempts = currentAttempts + 1;
    try {
      writeSession(workspacePath, session);
    } catch {
      // Writing the pending state is non-fatal — we still run the audit.
      // The next caller will just see auditStatus undefined and may race
      // with us, which is an acceptable degradation.
    }

    // Write the initial audit log entry. This file will be updated as the
    // audit progresses (chunks, extractions, final verdict). Per-session
    // audit logs live in .axme-code/audit-logs/ for operator inspection.
    const claudeSessionIds = (session.claudeSessions ?? []).map(c => c.id);
    const auditLog: AuditLog = {
      axmeSessionId: sessionId,
      claudeSessionIds,
      startedAt: auditStartIso,
      phase: "started",
      model: config.auditorModel,
      filesChangedCount: filesChanged.length,
    };
    let auditLogPath = "";
    try {
      auditLogPath = writeAuditLog(workspacePath, auditLog);
    } catch {
      // Audit log failure is non-fatal.
    }

    try {
      const { runSessionAudit } = await import("./agents/session-auditor.js");

      const audit = await runSessionAudit({
        sessionId,
        sessionOrigin: workspacePath,
        workspaceInfo: isWorkspaceSession ? workspaceInfo : undefined,
        sessionTurns,
        sessionEvents,
        filesChanged,
        model: config.auditorModel,
      });

      // Per-extraction logging: snapshot existing slugs at every potential
      // target path BEFORE saving, so we can classify each saved item as
      // "saved" (new) or "deduped" (slug already existed, overwritten).
      const extractions: AuditLogExtraction[] = [];

      // Collect all possible target paths for this audit so we can snapshot once.
      const allTargets = new Set<string>();
      for (const m of audit.memories) {
        for (const p of resolveScopeRoutes(m.scope, workspacePath, workspaceRoot)) allTargets.add(p);
      }
      for (const d of audit.decisions) {
        for (const p of resolveScopeRoutes(d.scope, workspacePath, workspaceRoot)) allTargets.add(p);
      }
      const snapshot = snapshotExistingSlugs(Array.from(allTargets));

      // Route memories by scope. saveScopedMemories handles the routing.
      if (audit.memories.length > 0) {
        for (const m of audit.memories) {
          const routes = resolveScopeRoutes(m.scope, workspacePath, workspaceRoot);
          const wasDuplicate = routes.every(p => snapshot.memories[p]?.has(m.slug));
          extractions.push({
            type: "memory",
            slug: m.slug,
            title: m.title,
            scope: m.scope,
            proposedRoutes: routes,
            status: wasDuplicate ? "updated" : "saved",
            reason: wasDuplicate ? "slug already existed, file overwritten" : undefined,
          });
        }
        saveScopedMemories(audit.memories, workspacePath, workspaceRoot);
      }

      // Decisions: handle action=new/supersede/amend from auditor output.
      if (audit.decisions.length > 0) {
        const newDecisions: typeof audit.decisions = [];
        for (const d of audit.decisions) {
          const action = (d as any)._action || "new";
          const routes = resolveScopeRoutes(d.scope, workspacePath, workspaceRoot);
          const wasDuplicate = routes.every(p => snapshot.decisions[p]?.has(d.slug));

          if (action === "supersede" && (d as any).supersedes?.length) {
            // Try to supersede the old decision at workspace path
            const oldId = (d as any).supersedes[0];
            try {
              const { newDecision } = supersedeDecision(workspacePath, oldId, d);
              extractions.push({
                type: "decision", slug: d.slug, title: d.title,
                scope: d.scope, proposedRoutes: routes,
                status: "saved",
                reason: `superseded ${oldId} with ${newDecision.id}`,
              });
            } catch {
              // Old decision not found — fall through to normal save
              newDecisions.push(d);
              extractions.push({
                type: "decision", slug: d.slug, title: d.title,
                scope: d.scope, proposedRoutes: routes,
                status: wasDuplicate ? "deduped" : "saved",
                reason: `supersede target ${oldId} not found, saved as new`,
              });
            }
            continue;
          }

          if (action === "amend" && (d as any)._amendsId) {
            // Amend = save with same slug. addDecision dedup by title will
            // find the existing entry and overwrite it. The auditor should
            // have used the same title as the original decision for amend.
            newDecisions.push(d);
            extractions.push({
              type: "decision", slug: d.slug, title: d.title,
              scope: d.scope, proposedRoutes: routes,
              status: "saved", reason: `amended ${(d as any)._amendsId}`,
            });
            continue;
          }

          // Default: new decision
          newDecisions.push(d);
          extractions.push({
            type: "decision", slug: d.slug, title: d.title,
            scope: d.scope, proposedRoutes: routes,
            status: wasDuplicate ? "updated" : "saved",
            reason: wasDuplicate ? "slug already existed, file overwritten" : undefined,
          });
        }
        if (newDecisions.length > 0) {
          saveScopedDecisions(newDecisions, workspacePath, workspaceRoot);
        }
      }

      // Safety rules: scope routing per rule.
      for (const r of audit.safetyRules) {
        const validTypes: SafetyRuleType[] = ["bash_deny", "bash_allow", "fs_deny", "git_protected_branch", "fs_readonly"];
        if (!validTypes.includes(r.ruleType as SafetyRuleType)) {
          extractions.push({
            type: "safety",
            ruleType: r.ruleType,
            value: r.value,
            scope: r.scope,
            proposedRoutes: [],
            status: "dropped",
            reason: `invalid rule_type: ${r.ruleType}`,
          });
          continue;
        }
        const routes = resolveScopeRoutes(r.scope, workspacePath, workspaceRoot);
        // For safety: check if the rule already exists at any target path
        // by loading the rules file and looking for the value in the
        // corresponding rule list.
        let alreadyPresent = routes.length > 0;
        for (const p of routes) {
          try {
            const rules = loadSafetyRules(p);
            const list = r.ruleType === "bash_deny" ? rules.bash.deniedPrefixes
              : r.ruleType === "bash_allow" ? rules.bash.allowedPrefixes
              : r.ruleType === "fs_deny" ? rules.filesystem.deniedPaths
              : r.ruleType === "fs_readonly" ? rules.filesystem.readOnlyPaths
              : r.ruleType === "git_protected_branch" ? rules.git.protectedBranches
              : [];
            if (!list.includes(r.value)) { alreadyPresent = false; break; }
          } catch { alreadyPresent = false; break; }
        }
        extractions.push({
          type: "safety",
          ruleType: r.ruleType,
          value: r.value,
          scope: r.scope,
          proposedRoutes: routes,
          status: alreadyPresent ? "deduped" : "saved",
          reason: alreadyPresent ? "rule value already present at all target paths" : undefined,
        });
        saveScopedSafetyRule(
          r.ruleType as SafetyRuleType,
          r.value,
          r.scope,
          workspacePath,
          workspaceRoot,
        );
      }

      // Handoff: always written to the session origin (workspacePath).
      // One handoff per AXME session — if the session was opened in a
      // workspace, handoff goes to workspace/.axme-code/plans/; if in a
      // single repo, it goes to that repo's .axme-code/plans/.
      if (audit.handoff) {
        writeHandoff(workspacePath, audit.handoff);
        result.handoffSaved = true;
      }

      // Append narrative session summary to worklog.md (dev diary).
      if (audit.sessionSummary) {
        try {
          const isoDate = new Date().toISOString().slice(0, 16).replace("T", " ");
          const shortId = sessionId.slice(0, 8);
          const title = audit.handoff?.stoppedAt?.slice(0, 80) || "Session work";
          const entry = `## ${isoDate} -- Session ${shortId}: ${title}\n\n${audit.sessionSummary}\n\n`;
          appendFileSync(join(workspacePath, AXME_CODE_DIR, "worklog.md"), entry);
          result.worklogSummary = true;
        } catch {}
      }

      // Save questions from auditor as open questions
      if (audit.questions && audit.questions.length > 0) {
        try {
          const { askQuestion } = await import("./storage/questions.js");
          for (const q of audit.questions) {
            askQuestion(workspacePath, {
              question: q.question,
              context: q.context,
              source: `session-${sessionId.slice(0, 8)}`,
            });
          }
        } catch {}
      }

      // Oracle rescan triggers — two paths:
      // 1. Deterministic: if filesChanged contains a structural manifest file
      //    (package.json, pyproject.toml, go.mod, CLAUDE.md, etc.) → always rescan
      // 2. LLM: if the auditor's ORACLE_CHANGES output said YES → rescan
      const STRUCTURAL_FILE_PATTERNS = [
        /\/package\.json$/,
        /\/pyproject\.toml$/,
        /\/go\.mod$/,
        /\/Cargo\.toml$/,
        /\/pom\.xml$/,
        /\/build\.gradle(\.kts)?$/,
        /\/requirements\.txt$/,
        /\/CLAUDE\.md$/,
        /\/AGENTS\.md$/,
      ];
      const deterministicRescan = filesChanged.some(f =>
        STRUCTURAL_FILE_PATTERNS.some(p => p.test(f))
      );
      const shouldRescan = deterministicRescan || audit.oracleNeedsRescan;
      if (shouldRescan && filesChanged.length > 0) {
        try {
          const { runOracleScan } = await import("./agents/scanners/oracle.js");
          const oracleResult = await runOracleScan({ projectPath: workspacePath });
          writeOracleFiles(workspacePath, oracleResult.files);
          result.oracleRescanned = true;
        } catch (err) {
          // Oracle rescan failure is non-fatal — audit artifacts are already saved.
          // But we record it so the operator has visibility.
          const msg = err instanceof Error ? err.message : String(err);
          try { logError(workspacePath, sessionId, `oracle rescan failed: ${msg}`); } catch {}
          process.stderr.write(`AXME oracle rescan failed for ${sessionId}: ${msg}\n`);
        }
      }

      result.auditRan = true;
      result.memories = audit.memories.length;
      result.decisions = audit.decisions.length;
      result.safetyRules = audit.safetyRules.length;
      result.costUsd = audit.cost?.costUsd ?? 0;
      auditSucceeded = true;

      // Bump KB audit counter — after N session audits, recommend deep KB cleanup
      try {
        const { incrementKbAuditCounter } = await import("./storage/kb-audit.js");
        const { count, recommendAudit } = incrementKbAuditCounter(workspacePath);
        if (recommendAudit) {
          process.stderr.write(
            `AXME: KB audit recommended (${count} sessions since last run). Run: axme-code audit-kb\n`,
          );
        }
      } catch {}

      // Resume-audit checkpoint: persist per-Claude-session end offsets so
      // the next audit of the same transcript (session reopen, restart
      // recovery) starts from here instead of re-reading the full file.
      // Only do this on success — on failure the old offset stays so a
      // retry re-processes the same turns.
      for (const ref of claudeSessions) {
        const endOffset = newEndOffsets[ref.id];
        if (endOffset != null && endOffset > (startOffsets[ref.id] ?? 0)) {
          try {
            writeAuditedOffset(workspacePath, ref.id, endOffset);
          } catch {
            // Non-fatal: worst case the next audit re-reads already-audited
            // turns and relies on the in-prompt dedup check to avoid double
            // extraction. Logged elsewhere.
          }
        }
      }

      // Build resume-audit telemetry: one entry per attached Claude session,
      // showing where this audit started reading, where it stopped, and
      // whether the resume optimization kicked in (non-zero startOffset).
      const resumeInfo: AuditLogResumeInfo[] = claudeSessions.map(ref => {
        const startOffset = startOffsets[ref.id] ?? 0;
        const endOffset = newEndOffsets[ref.id] ?? startOffset;
        return {
          claudeSessionId: ref.id,
          startOffset,
          endOffset,
          bytesRead: bytesReadPerRef[ref.id] ?? 0,
          resumed: startOffset > 0,
        };
      });

      // Finalize audit log with full extraction breakdown, totals, and resume info.
      if (auditLogPath) {
        const mSaved = extractions.filter(e => e.type === "memory" && e.status === "saved").length;
        const mDeduped = extractions.filter(e => e.type === "memory" && e.status === "deduped").length;
        const dSaved = extractions.filter(e => e.type === "decision" && e.status === "saved").length;
        const dDeduped = extractions.filter(e => e.type === "decision" && e.status === "deduped").length;
        const sSaved = extractions.filter(e => e.type === "safety" && e.status === "saved").length;
        const sDeduped = extractions.filter(e => e.type === "safety" && e.status === "deduped").length;
        updateAuditLog(auditLogPath, {
          phase: "finished",
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - auditStartMs,
          chunks: audit.chunks,
          promptTokens: audit.promptTokens,
          costUsd: audit.cost?.costUsd ?? 0,
          extractions,
          resume: resumeInfo,
          totals: {
            memoriesExtracted: audit.memories.length,
            memoriesSaved: mSaved,
            memoriesDeduped: mDeduped,
            decisionsExtracted: audit.decisions.length,
            decisionsSaved: dSaved,
            decisionsDeduped: dDeduped,
            safetyExtracted: audit.safetyRules.length,
            safetySaved: sSaved,
            safetyDeduped: sDeduped,
          },
        });
      }
    } catch (err) {
      // Audit failure is non-fatal for the caller (we still close the session),
      // but it MUST be logged. Silent swallowing is an anti-pattern. The retry
      // cap (MAX_AUDIT_ATTEMPTS) prevents infinite re-runs. recordAuditFailure
      // sets auditStatus=failed + auditFinishedAt + lastAuditError on the meta.
      recordAuditFailure(workspacePath, sessionId, err, "runSessionAudit");
      if (auditLogPath) {
        updateAuditLog(auditLogPath, {
          phase: "failed",
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - auditStartMs,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Mark audited only on success (or when there was nothing to audit).
  // Failed audits leave auditedAt null so startup fallback retries them.
  if (auditSucceeded || !hasActivity) {
    markAudited(workspacePath, sessionId);
  }

  // Always close the session — leaving closedAt=null would cause the MCP
  // server to appear mid-run on exit, or the startup fallback to repeatedly
  // see the session as a pending candidate even if audit already succeeded.
  closeSession(workspacePath, sessionId);

  logSessionEnd(workspacePath, sessionId, {
    filesCount: filesChanged.length,
    auditRan: result.auditRan,
  });

  // Log structured audit result with cost and extraction counts.
  if (result.auditRan) {
    try {
      const details = `${result.memories} mem, ${result.decisions} dec, ${result.safetyRules} safety`;
      logCheckResult(workspacePath, sessionId, "auditor", "PASS", details);
      logAuditComplete(workspacePath, sessionId, {
        costUsd: result.costUsd,
        memories: result.memories,
        decisions: result.decisions,
        safety: result.safetyRules,
        durationMs: 0, // duration is in audit-logs, not needed here
      });
    } catch {}
  }

  // Note: clearing the per-Claude-session mapping file is the caller's
  // responsibility — they know which Claude session_id to clear. The
  // SessionEnd hook and MCP server transport-close handler both do this.

  return result;
}
