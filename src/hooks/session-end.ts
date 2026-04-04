/**
 * SessionEnd hook - runs when Claude session closes.
 *
 * 1. Reads session worklog events
 * 2. Runs memory extraction (LLM: Haiku, ~$0.05, best-effort)
 * 3. Saves extracted memories
 * 4. Writes final session summary to worklog
 * 5. Closes session metadata
 *
 * Called by Claude Code hooks system via: axme-code hook session-end <json>
 */

import { readWorklog, logSessionEnd } from "../storage/worklog.js";
import { saveMemories } from "../storage/memory.js";
import { closeSession, loadSession } from "../storage/sessions.js";
import { pathExists } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";

export interface SessionEndEvent {
  session_id: string;
  project_path: string;
}

/**
 * Handle session end: extract memories and close session.
 */
export async function handleSessionEnd(event: SessionEndEvent): Promise<void> {
  const { session_id, project_path } = event;

  if (!pathExists(join(project_path, AXME_CODE_DIR))) return;

  // Read recent worklog events for this session
  const events = readWorklog(project_path, { limit: 100 });
  const sessionEvents = events
    .filter(e => e.sessionId === session_id)
    .reverse() // chronological
    .map(e => `[${e.timestamp}] ${e.type}: ${JSON.stringify(e.data)}`)
    .join("\n");

  // Run memory extraction (best-effort, don't fail the hook)
  if (sessionEvents.length > 100) {
    try {
      const { runMemoryExtraction } = await import("../agents/memory-extractor.js");
      const result = await runMemoryExtraction({
        sessionId: session_id,
        sessionEvents,
        projectPath: project_path,
      });

      if (result.memories.length > 0) {
        saveMemories(project_path, result.memories);
      }
    } catch {
      // Memory extraction is best-effort - never break the session close
    }
  }

  // Log session end
  const session = loadSession(project_path, session_id);
  logSessionEnd(project_path, session_id, {
    turns: session?.turns ?? 0,
    filesChanged: session?.filesChanged ?? [],
  });

  // Close session
  closeSession(project_path, session_id);
}

/**
 * CLI entry point for hook.
 */
export async function runSessionEndHook(): Promise<void> {
  const arg = process.argv[3]; // axme-code hook session-end <json>
  if (!arg) return;

  try {
    const event = JSON.parse(arg) as SessionEndEvent;
    await handleSessionEnd(event);
  } catch {
    // Hook failures must be silent
  }
}
