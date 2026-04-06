/**
 * Status tools - axme_status, axme_worklog.
 */

import { listSessions, getLastSession } from "../storage/sessions.js";
import { showWorklog, readWorklog } from "../storage/worklog.js";
import { listDecisions } from "../storage/decisions.js";
import { listMemories } from "../storage/memory.js";
import { oracleExists } from "../storage/oracle.js";
import { safetyExists } from "../storage/safety.js";
import { pathExists } from "../storage/engine.js";
import { join } from "node:path";
import { AXME_CODE_DIR } from "../types.js";

export function statusTool(projectPath: string): string {
  const initialized = pathExists(join(projectPath, AXME_CODE_DIR));
  if (!initialized) return "Project not initialized. Run axme_init first.";

  const oracle = oracleExists(projectPath) ? "initialized" : "not initialized";
  const decisions = listDecisions(projectPath);
  const memories = listMemories(projectPath);
  const safety = safetyExists(projectPath) ? "configured" : "not configured";
  const sessions = listSessions(projectPath);
  const lastSession = getLastSession(projectPath);
  const events = readWorklog(projectPath, { limit: 1 });

  const lines = [
    "# AXME Code Status",
    "",
    `Oracle: ${oracle}`,
    `Decisions: ${decisions.length} recorded`,
    `  Required: ${decisions.filter(d => d.enforce === "required").length}`,
    `  Advisory: ${decisions.filter(d => d.enforce === "advisory").length}`,
    `Memories: ${memories.length} total`,
    `  Feedback: ${memories.filter(m => m.type === "feedback").length}`,
    `  Patterns: ${memories.filter(m => m.type === "pattern").length}`,
    `Safety: ${safety}`,
    `Sessions: ${sessions.length} total`,
  ];

  if (lastSession) {
    lines.push(`Last session: ${lastSession.createdAt.slice(0, 19).replace("T", " ")} (${lastSession.filesChanged.length} files changed)`);
  }

  if (events.length > 0) {
    lines.push(`Last event: ${events[0].timestamp.slice(0, 19).replace("T", " ")} (${events[0].type})`);
  }

  return lines.join("\n");
}

export function worklogTool(projectPath: string, limit: number = 20): string {
  return showWorklog(projectPath, limit);
}
