/**
 * Read AXME health signals from disk for the sidebar's Status block.
 *
 * Three signals, all derived from `.axme-code/` and the bundled binary's
 * presence:
 *
 *   - pendingAudits: count of sessions whose meta.auditStatus is
 *     "pending" (background audit-worker still running). When > 0, the
 *     KB is incomplete — the next session's axme_context will be
 *     missing the latest extractions.
 *   - lastAuditError: most recent failed audit message across all
 *     sessions. Surfacing this is the only way users notice a crashed
 *     auditor without trawling .axme-code/audit-worker-logs/.
 *   - lastHandoffPath / lastHandoffAgeMs: the most recent file under
 *     .axme-code/plans/handoff-*.md. Tells the user when the last clean
 *     session-close happened, which is the cross-session continuity
 *     anchor.
 *
 * Everything here is a synchronous file-read — kept cheap because the
 * sidebar polls this every 5 s alongside the KB-counts watcher. No
 * subprocess, no async I/O.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface HealthSnapshot {
  pendingAudits: number;
  /** Most recent failed audit message + when. Undefined if none. */
  lastAuditError?: { message: string; whenIso: string };
  /** Path to most recent handoff-*.md. Undefined if no handoff yet. */
  lastHandoffPath?: string;
  /** ms since most recent handoff mtime. Undefined if none. */
  lastHandoffAgeMs?: number;
}

interface SessionMetaShape {
  id?: string;
  auditStatus?: "pending" | "success" | "failed" | string;
  lastAuditError?: string;
  auditStartedAt?: string;
  auditFinishedAt?: string;
}

export function readHealth(workspaceRoot: string): HealthSnapshot {
  const axmeDir = join(workspaceRoot, ".axme-code");
  if (!existsSync(axmeDir)) return { pendingAudits: 0 };

  let pendingAudits = 0;
  let lastError: { message: string; whenIso: string } | undefined;

  const sessionsRoot = join(axmeDir, "sessions");
  if (existsSync(sessionsRoot)) {
    let sessionIds: string[] = [];
    try { sessionIds = readdirSync(sessionsRoot); } catch { /* skip */ }
    for (const sid of sessionIds) {
      const metaPath = join(sessionsRoot, sid, "meta.json");
      if (!existsSync(metaPath)) continue;
      let meta: SessionMetaShape = {};
      try { meta = JSON.parse(readFileSync(metaPath, "utf-8")); } catch { continue; }
      if (meta.auditStatus === "pending") pendingAudits++;
      if (meta.auditStatus === "failed" && meta.lastAuditError) {
        const whenIso = meta.auditFinishedAt ?? meta.auditStartedAt ?? "";
        if (!lastError || whenIso > lastError.whenIso) {
          lastError = { message: meta.lastAuditError.slice(0, 200), whenIso };
        }
      }
    }
  }

  let lastHandoffPath: string | undefined;
  let lastHandoffAgeMs: number | undefined;
  const plansDir = join(axmeDir, "plans");
  if (existsSync(plansDir)) {
    let files: string[] = [];
    try { files = readdirSync(plansDir).filter((f) => f.startsWith("handoff-") && f.endsWith(".md")); }
    catch { /* skip */ }
    let bestMtime = 0;
    for (const f of files) {
      const p = join(plansDir, f);
      try {
        const m = statSync(p).mtimeMs;
        if (m > bestMtime) { bestMtime = m; lastHandoffPath = p; }
      } catch { /* skip */ }
    }
    if (bestMtime > 0) lastHandoffAgeMs = Date.now() - bestMtime;
  }

  return { pendingAudits, lastAuditError: lastError, lastHandoffPath, lastHandoffAgeMs };
}
