/**
 * SessionEnd hook - runs when Claude session closes.
 *
 * Full session audit:
 * 1. Reads session worklog + filesChanged
 * 2. Runs session-auditor LLM (Sonnet, ~$0.30) - extracts ALL:
 *    memories, decisions, safety rules, oracle change detection
 * 3. Saves everything to storage modules
 * 4. If oracle needs re-scan: runs full Oracle Scanner
 * 5. Closes session
 *
 * Workspace path: passed via --workspace flag (hardcoded at setup time).
 * Session ID: read from .axme-code/active-session.
 */

import { readWorklog, logSessionEnd } from "../storage/worklog.js";
import { saveMemories } from "../storage/memory.js";
import { addDecision, listDecisions } from "../storage/decisions.js";
import { updateSafetyRule } from "../storage/safety.js";
import { writeOracleFiles, oracleContext } from "../storage/oracle.js";
import { closeSession, loadSession, readActiveSession, clearActiveSession } from "../storage/sessions.js";
import { pathExists } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";

async function handleSessionEnd(workspacePath: string): Promise<void> {
  if (!pathExists(join(workspacePath, AXME_CODE_DIR))) return;

  const sessionId = readActiveSession(workspacePath);
  if (!sessionId) return;

  const session = loadSession(workspacePath, sessionId);
  const filesChanged = session?.filesChanged ?? [];
  const events = readWorklog(workspacePath, { limit: 200 });
  const sessionEvents = events
    .filter(e => e.sessionId === sessionId)
    .reverse()
    .map(e => `[${e.timestamp}] ${e.type}: ${JSON.stringify(e.data)}`)
    .join("\n");

  if (sessionEvents.length > 50) {
    try {
      const { runSessionAudit } = await import("../agents/session-auditor.js");

      const oracleSummary = oracleContext(workspacePath).slice(0, 500);
      const decisionsCount = listDecisions(workspacePath).length;

      const audit = await runSessionAudit({
        sessionId,
        sessionEvents,
        filesChanged,
        projectPath: workspacePath,
        oracleSummary,
        decisionsCount,
      });

      if (audit.memories.length > 0) saveMemories(workspacePath, audit.memories);

      for (const d of audit.decisions) addDecision(workspacePath, d);

      for (const r of audit.safetyRules) {
        const validTypes = ["bash_deny", "bash_allow", "fs_deny", "git_protected_branch"] as const;
        if (validTypes.includes(r.ruleType as any)) {
          updateSafetyRule(workspacePath, r.ruleType as any, r.value);
        }
      }

      if (audit.oracleNeedsRescan && filesChanged.length > 0) {
        try {
          const { runOracleScan } = await import("../agents/scanners/oracle.js");
          const oracleResult = await runOracleScan({ projectPath: workspacePath });
          writeOracleFiles(workspacePath, oracleResult.files);
        } catch {}
      }
    } catch {}
  }

  logSessionEnd(workspacePath, sessionId, {
    turns: session?.turns ?? 0,
    filesChanged,
  });

  closeSession(workspacePath, sessionId);
  clearActiveSession(workspacePath);
}

/**
 * CLI entry point - reads JSON from stdin.
 * @param workspacePath - from --workspace CLI flag
 */
export async function runSessionEndHook(workspacePath?: string): Promise<void> {
  if (!workspacePath) return;

  try {
    // Still consume stdin (Claude Code sends it), but we don't need its content
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    await handleSessionEnd(workspacePath);
  } catch {
    // Hook failures must be silent
  }
}
