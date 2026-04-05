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
import { readWorklog, logSessionEnd, logError } from "./storage/worklog.js";
import { saveScopedMemories } from "./storage/memory.js";
import { saveScopedDecisions } from "./storage/decisions.js";
import { saveScopedSafetyRule, type SafetyRuleType } from "./storage/safety.js";
import { writeOracleFiles } from "./storage/oracle.js";
import { writeHandoff } from "./storage/plans.js";
import {
  closeSession,
  loadSession,
  markAudited,
  writeSession,
} from "./storage/sessions.js";
import { pathExists } from "./storage/engine.js";
import { parseAndRenderTranscripts } from "./transcript-parser.js";
import { detectWorkspace } from "./utils/workspace-detector.js";
import { readConfig } from "./storage/config.js";
import { AXME_CODE_DIR } from "./types.js";

/**
 * Record an audit failure on the session: bump auditAttempts, save lastAuditError,
 * log to worklog, write to stderr. Silent swallow is an anti-pattern.
 */
function recordAuditFailure(
  workspacePath: string,
  sessionId: string,
  err: unknown,
  phase: string,
): void {
  const errMsg = err instanceof Error ? err.message : String(err);
  const errStack = err instanceof Error ? err.stack : undefined;
  try {
    const s = loadSession(workspacePath, sessionId);
    if (s) {
      s.auditAttempts = (s.auditAttempts ?? 0) + 1;
      s.lastAuditError = `[${phase}] ${errMsg}`;
      writeSession(workspacePath, s);
    }
  } catch {
    // Secondary failure writing the error record itself — nothing else we can do.
  }
  try {
    logError(workspacePath, sessionId, `audit failed (${phase}): ${errMsg}`);
  } catch {}
  process.stderr.write(`AXME audit failed (${phase}) for ${sessionId}: ${errStack ?? errMsg}\n`);
}

export interface SessionCleanupResult {
  sessionId: string;
  auditRan: boolean;
  memories: number;
  decisions: number;
  safetyRules: number;
  handoffSaved: boolean;
  oracleRescanned: boolean;
  costUsd: number;
  skipped?: "already-audited" | "not-found" | "no-storage";
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

  // Dedup: if audit already ran, don't repeat. Just ensure session is closed.
  if (session.auditedAt) {
    if (!session.closedAt) closeSession(workspacePath, sessionId);
    return { ...base, skipped: "already-audited" };
  }

  const filesChanged = session.filesChanged ?? [];

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
  if (claudeSessions.length > 0) {
    const parsed = parseAndRenderTranscripts(claudeSessions);
    if (parsed.allTurns.length > 0) {
      sessionTurns = parsed.allTurns;
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
  const hasActivity = activityLength > 50;

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

      // Route memories by scope: workspace-level ("all") vs specific repo vs
      // fallback to session origin. saveScopedMemories handles the routing.
      if (audit.memories.length > 0) {
        saveScopedMemories(audit.memories, workspacePath, workspaceRoot);
      }

      // Same scope routing for decisions. saveScopedDecisions accepts
      // Omit<Decision, "id"> and generates a fresh id per target path.
      if (audit.decisions.length > 0) {
        saveScopedDecisions(audit.decisions, workspacePath, workspaceRoot);
      }

      // Safety rules: scope routing per rule.
      for (const r of audit.safetyRules) {
        const validTypes: SafetyRuleType[] = ["bash_deny", "bash_allow", "fs_deny", "git_protected_branch", "fs_readonly"];
        if (validTypes.includes(r.ruleType as SafetyRuleType)) {
          saveScopedSafetyRule(
            r.ruleType as SafetyRuleType,
            r.value,
            r.scope,
            workspacePath,
            workspaceRoot,
          );
        }
      }

      // Handoff: always written to the session origin (workspacePath).
      // One handoff per AXME session — if the session was opened in a
      // workspace, handoff goes to workspace/.axme-code/plans/; if in a
      // single repo, it goes to that repo's .axme-code/plans/.
      if (audit.handoff) {
        writeHandoff(workspacePath, audit.handoff);
        result.handoffSaved = true;
      }

      if (audit.oracleNeedsRescan && filesChanged.length > 0) {
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
    } catch (err) {
      // Audit failure is non-fatal for the caller (we still close the session),
      // but it MUST be logged. Silent swallowing is an anti-pattern. The retry
      // cap in findOrphanSessions prevents infinite re-runs.
      recordAuditFailure(workspacePath, sessionId, err, "runSessionAudit");
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
    turns: session.turns,
    filesChanged,
    auditRan: result.auditRan,
  });

  // Note: clearing the per-Claude-session mapping file is the caller's
  // responsibility — they know which Claude session_id to clear. The
  // SessionEnd hook and MCP server transport-close handler both do this.

  return result;
}
