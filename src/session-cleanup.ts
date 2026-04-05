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
import { readWorklog, logSessionEnd } from "./storage/worklog.js";
import { saveMemories } from "./storage/memory.js";
import { addDecision } from "./storage/decisions.js";
import { updateSafetyRule } from "./storage/safety.js";
import { writeOracleFiles } from "./storage/oracle.js";
import { writeHandoff } from "./storage/plans.js";
import {
  closeSession,
  loadSession,
  markAudited,
  clearActiveSession,
  readActiveSession,
} from "./storage/sessions.js";
import { pathExists } from "./storage/engine.js";
import { parseAndRenderTranscripts } from "./transcript-parser.js";
import { AXME_CODE_DIR } from "./types.js";

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
 * @param sessionId - UUID of the session to audit and close
 * @param opts.clearActive - If true, also clears .axme-code/active-session (only the
 *                           currently-active MCP server should do this)
 */
export async function runSessionCleanup(
  workspacePath: string,
  sessionId: string,
  opts: { clearActive?: boolean } = {},
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
    if (opts.clearActive && readActiveSession(workspacePath) === sessionId) {
      clearActiveSession(workspacePath);
    }
    return { ...base, skipped: "already-audited" };
  }

  const filesChanged = session.filesChanged ?? [];

  // Prefer the Claude Code transcript (filtered conversation) over the worklog
  // when available. Transcripts contain the actual user/assistant dialog with
  // reasoning, corrections, and agreements — exactly what the auditor needs.
  // The worklog only has sparse structural events (session_start, memory_saved, etc).
  const claudeSessions = session.claudeSessions ?? [];
  let sessionTranscript: string | undefined;
  if (claudeSessions.length > 0) {
    const parsed = parseAndRenderTranscripts(claudeSessions);
    if (parsed.rendered.length > 0) {
      sessionTranscript = parsed.rendered;
    }
  }

  // Fallback: if no transcript is attached (pre-transcript-audit sessions, or
  // a session that ended before any hook fired), use the worklog events.
  let sessionEvents: string | undefined;
  if (!sessionTranscript) {
    const events = readWorklog(workspacePath, { limit: 500 });
    sessionEvents = events
      .filter(e => e.sessionId === sessionId)
      .reverse()
      .map(e => `[${e.timestamp}] ${e.type}: ${JSON.stringify(e.data)}`)
      .join("\n");
  }

  const result: SessionCleanupResult = { ...base };
  let auditSucceeded = false;
  const activityLength = (sessionTranscript ?? sessionEvents ?? "").length;
  const hasActivity = activityLength > 50;

  // Run LLM audit only if there's meaningful activity to analyze
  if (hasActivity) {
    try {
      const { runSessionAudit } = await import("./agents/session-auditor.js");

      const audit = await runSessionAudit({
        sessionId,
        sessionTranscript,
        sessionEvents,
        filesChanged,
        projectPath: workspacePath,
      });

      if (audit.memories.length > 0) saveMemories(workspacePath, audit.memories);
      for (const d of audit.decisions) addDecision(workspacePath, d);

      for (const r of audit.safetyRules) {
        const validTypes = ["bash_deny", "bash_allow", "fs_deny", "git_protected_branch"] as const;
        if (validTypes.includes(r.ruleType as any)) {
          updateSafetyRule(workspacePath, r.ruleType as any, r.value);
        }
      }

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
        } catch {
          // Oracle rescan failure is non-fatal — audit artifacts already saved
        }
      }

      result.auditRan = true;
      result.memories = audit.memories.length;
      result.decisions = audit.decisions.length;
      result.safetyRules = audit.safetyRules.length;
      result.costUsd = audit.cost?.costUsd ?? 0;
      auditSucceeded = true;
    } catch {
      // Audit failure is non-fatal. We deliberately leave auditedAt null so
      // the startup fallback can retry on the next MCP server start.
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

  if (opts.clearActive && readActiveSession(workspacePath) === sessionId) {
    clearActiveSession(workspacePath);
  }

  return result;
}
