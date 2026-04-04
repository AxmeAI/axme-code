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
 * Input: JSON on stdin from Claude Code hooks system.
 * Format: { session_id, cwd, hook_event_name }
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

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
}

async function handleSessionEnd(input: HookInput): Promise<void> {
  const { session_id, cwd } = input;

  if (!pathExists(join(cwd, AXME_CODE_DIR))) return;

  const session = loadSession(cwd, session_id);
  const filesChanged = session?.filesChanged ?? [];
  const events = readWorklog(cwd, { limit: 200 });
  const sessionEvents = events
    .filter(e => e.sessionId === session_id)
    .reverse()
    .map(e => `[${e.timestamp}] ${e.type}: ${JSON.stringify(e.data)}`)
    .join("\n");

  if (sessionEvents.length > 50) {
    try {
      const { runSessionAudit } = await import("../agents/session-auditor.js");

      const oracleSummary = oracleContext(cwd).slice(0, 500);
      const decisionsCount = listDecisions(cwd).length;

      const audit = await runSessionAudit({
        sessionId: session_id,
        sessionEvents,
        filesChanged,
        projectPath: cwd,
        oracleSummary,
        decisionsCount,
      });

      if (audit.memories.length > 0) saveMemories(cwd, audit.memories);

      for (const d of audit.decisions) addDecision(cwd, d);

      for (const r of audit.safetyRules) {
        const validTypes = ["bash_deny", "bash_allow", "fs_deny", "git_protected_branch"] as const;
        if (validTypes.includes(r.ruleType as any)) {
          updateSafetyRule(cwd, r.ruleType as any, r.value);
        }
      }

      if (audit.oracleNeedsRescan && filesChanged.length > 0) {
        try {
          const { runOracleScan } = await import("../agents/scanners/oracle.js");
          const oracleResult = await runOracleScan({ projectPath: cwd });
          writeOracleFiles(cwd, oracleResult.files);
        } catch {}
      }
    } catch {}
  }

  logSessionEnd(cwd, session_id, {
    turns: session?.turns ?? 0,
    filesChanged,
  });

  closeSession(cwd, session_id);
}

/**
 * CLI entry point - reads JSON from stdin.
 */
export async function runSessionEndHook(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as HookInput;
    await handleSessionEnd(input);
  } catch {
    // Hook failures must be silent
  }
}
