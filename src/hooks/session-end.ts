/**
 * SessionEnd hook - runs when Claude session closes.
 *
 * Full session audit:
 * 1. Reads session worklog + filesChanged
 * 2. Runs session-auditor LLM (Sonnet, ~$0.30) - extracts ALL:
 *    - Memories (feedback + patterns)
 *    - Decisions (new architectural decisions)
 *    - Safety rules (new constraints)
 *    - Oracle change detection
 * 3. Saves everything to storage modules
 * 4. If oracle needs re-scan: runs full Oracle Scanner (Sonnet, $0.20-0.50)
 * 5. Closes session
 *
 * Called by Claude Code hooks via: axme-code hook session-end <json>
 */

import { readWorklog, logSessionEnd } from "../storage/worklog.js";
import { saveMemories } from "../storage/memory.js";
import { addDecision, listDecisions } from "../storage/decisions.js";
import { updateSafetyRule } from "../storage/safety.js";
import { writeOracleFiles, oracleContext } from "../storage/oracle.js";
import { closeSession, loadSession } from "../storage/sessions.js";
import { pathExists } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";

export interface SessionEndEvent {
  session_id: string;
  project_path: string;
}

/**
 * Handle session end: full audit + oracle re-scan if needed.
 */
export async function handleSessionEnd(event: SessionEndEvent): Promise<void> {
  const { session_id, project_path } = event;

  if (!pathExists(join(project_path, AXME_CODE_DIR))) return;

  // Read session data
  const session = loadSession(project_path, session_id);
  const filesChanged = session?.filesChanged ?? [];
  const events = readWorklog(project_path, { limit: 200 });
  const sessionEvents = events
    .filter(e => e.sessionId === session_id)
    .reverse()
    .map(e => `[${e.timestamp}] ${e.type}: ${JSON.stringify(e.data)}`)
    .join("\n");

  // Only run audit if there's meaningful session activity
  if (sessionEvents.length > 50) {
    try {
      const { runSessionAudit } = await import("../agents/session-auditor.js");

      const oracleSummary = oracleContext(project_path).slice(0, 500);
      const decisionsCount = listDecisions(project_path).length;

      const audit = await runSessionAudit({
        sessionId: session_id,
        sessionEvents,
        filesChanged,
        projectPath: project_path,
        oracleSummary,
        decisionsCount,
      });

      // Save memories
      if (audit.memories.length > 0) {
        saveMemories(project_path, audit.memories);
      }

      // Save decisions
      for (const d of audit.decisions) {
        addDecision(project_path, d);
      }

      // Save safety rules
      for (const r of audit.safetyRules) {
        const validTypes = ["bash_deny", "bash_allow", "fs_deny", "git_protected_branch"] as const;
        if (validTypes.includes(r.ruleType as any)) {
          updateSafetyRule(project_path, r.ruleType as any, r.value);
        }
      }

      // Oracle re-scan if structure changed
      if (audit.oracleNeedsRescan && filesChanged.length > 0) {
        try {
          const { runOracleScan } = await import("../agents/scanners/oracle.js");
          const oracleResult = await runOracleScan({ projectPath: project_path });
          writeOracleFiles(project_path, oracleResult.files);
        } catch {
          // Oracle re-scan is best-effort
        }
      }
    } catch {
      // Full audit is best-effort - never break session close
    }
  }

  // Log session end
  logSessionEnd(project_path, session_id, {
    turns: session?.turns ?? 0,
    filesChanged,
  });

  // Close session
  closeSession(project_path, session_id);
}

/**
 * CLI entry point for hook.
 */
export async function runSessionEndHook(): Promise<void> {
  const arg = process.argv[3];
  if (!arg) return;

  try {
    const event = JSON.parse(arg) as SessionEndEvent;
    await handleSessionEnd(event);
  } catch {
    // Hook failures must be silent
  }
}
