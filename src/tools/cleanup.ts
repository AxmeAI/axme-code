/**
 * Cleanup tools for removing legacy artifacts and normalizing storage.
 *
 * Commands:
 *   axme-code cleanup legacy-artifacts [--dry-run]
 *     Remove pre-PR#7 sessions (no origin field), audit logs (no resume field),
 *     and legacy directories.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { pathExists, readJson, removeFile } from "../storage/engine.js";
import { AXME_CODE_DIR } from "../types.js";
import type { SessionMeta } from "../types.js";
import type { AuditLog } from "../storage/sessions.js";

interface CleanupResult {
  sessionsDeleted: number;
  auditLogsDeleted: number;
  legacyDirsRemoved: string[];
  backupPath: string | null;
}

/**
 * Remove pre-PR#7 legacy artifacts from workspace-level .axme-code/.
 *
 * Targets:
 * - Sessions without `origin` field (created before PR#7 added it)
 * - Audit logs without `resume` array (created before PR#7 resume optimization)
 * - Legacy `pending-audits/` directory (replaced by auditStatus field)
 * - Legacy `active-session` file (replaced by per-Claude mapping)
 */
export function cleanupLegacyArtifacts(
  projectPath: string,
  opts: { dryRun: boolean; onProgress?: (msg: string) => void },
): CleanupResult {
  const log = opts.onProgress ?? (() => {});
  const result: CleanupResult = {
    sessionsDeleted: 0,
    auditLogsDeleted: 0,
    legacyDirsRemoved: [],
    backupPath: null,
  };

  const acDir = join(projectPath, AXME_CODE_DIR);
  if (!pathExists(acDir)) {
    log("No .axme-code/ found, nothing to clean.");
    return result;
  }

  // --- Backup ---
  const backupDir = join(acDir, "backups", `legacy-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  if (!opts.dryRun) {
    mkdirSync(backupDir, { recursive: true });
    result.backupPath = backupDir;
  }

  // --- Sessions without origin ---
  const sessionsDir = join(acDir, "sessions");
  if (pathExists(sessionsDir)) {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(sessionsDir, entry.name, "meta.json");
      const session = readJson<SessionMeta>(metaPath);
      if (!session) continue;
      if (session.origin) continue; // has origin, keep

      if (opts.dryRun) {
        log(`  [dry-run] would delete session ${entry.name} (no origin field)`);
      } else {
        // Backup meta.json before deletion
        const backupSessionDir = join(backupDir, "sessions", entry.name);
        mkdirSync(backupSessionDir, { recursive: true });
        try { copyFileSync(metaPath, join(backupSessionDir, "meta.json")); } catch {}
        // Delete session directory
        rmSync(join(sessionsDir, entry.name), { recursive: true, force: true });
        log(`  deleted session ${entry.name} (no origin)`);
      }
      result.sessionsDeleted++;
    }
  }

  // --- Audit logs without resume ---
  const auditLogsDir = join(acDir, "audit-logs");
  if (pathExists(auditLogsDir)) {
    for (const file of readdirSync(auditLogsDir).filter(f => f.endsWith(".json"))) {
      const logPath = join(auditLogsDir, file);
      const auditLog = readJson<AuditLog>(logPath);
      if (!auditLog) continue;
      if (auditLog.resume) continue; // has resume, keep

      if (opts.dryRun) {
        log(`  [dry-run] would delete audit log ${file} (no resume field)`);
      } else {
        const backupLogsDir = join(backupDir, "audit-logs");
        mkdirSync(backupLogsDir, { recursive: true });
        try { copyFileSync(logPath, join(backupLogsDir, file)); } catch {}
        removeFile(logPath);
        log(`  deleted audit log ${file} (no resume)`);
      }
      result.auditLogsDeleted++;
    }
  }

  // --- Legacy directories ---
  const legacyPaths = [
    join(acDir, "pending-audits"),
    join(acDir, "active-session"),
  ];
  for (const p of legacyPaths) {
    if (!pathExists(p)) continue;
    const name = basename(p) ?? p;
    if (opts.dryRun) {
      log(`  [dry-run] would remove legacy ${name}`);
    } else {
      rmSync(p, { recursive: true, force: true });
      log(`  removed legacy ${name}`);
    }
    result.legacyDirsRemoved.push(name);
  }

  return result;
}

/**
 * Normalize all decisions across workspace: add `status: active` to decisions
 * that don't have a status field. Idempotent - safe to run multiple times.
 */
export function normalizeDecisions(
  workspacePath: string,
  opts: { dryRun: boolean; onProgress?: (msg: string) => void },
): { filesUpdated: number; filesSkipped: number; locations: number } {
  const log = opts.onProgress ?? (() => {});
  let filesUpdated = 0;
  let filesSkipped = 0;
  let locations = 0;

  // Collect all .axme-code/decisions/ paths: workspace root + per-repo
  const targets: string[] = [];
  const wsDecDir = join(workspacePath, AXME_CODE_DIR, "decisions");
  if (pathExists(wsDecDir)) targets.push(wsDecDir);

  try {
    for (const entry of readdirSync(workspacePath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const repoDecDir = join(workspacePath, entry.name, AXME_CODE_DIR, "decisions");
      if (pathExists(repoDecDir)) targets.push(repoDecDir);
    }
  } catch {}

  for (const decDir of targets) {
    locations++;
    const name = decDir.split("/").slice(-3, -1).join("/");
    let updated = 0;
    try {
      for (const file of readdirSync(decDir).filter(f => f.startsWith("D-") && f.endsWith(".md"))) {
        const filePath = join(decDir, file);
        const content = readFileSync(filePath, "utf-8");
        // Check if status field already exists in frontmatter
        if (/^status:\s/m.test(content)) {
          filesSkipped++;
          continue;
        }
        // Add status: active after sessionId line (or after enforce line)
        const insertAfter = content.match(/^(sessionId:.*$)/m);
        if (!insertAfter) {
          filesSkipped++;
          continue;
        }
        if (opts.dryRun) {
          filesUpdated++;
          updated++;
          continue;
        }
        const newContent = content.replace(
          insertAfter[0],
          insertAfter[0] + "\nstatus: active",
        );
        writeFileSync(filePath, newContent, "utf-8");
        filesUpdated++;
        updated++;
      }
    } catch {}
    if (updated > 0 || opts.dryRun) {
      log(`  ${name}: ${updated} decisions ${opts.dryRun ? "would be" : ""} normalized`);
    }
  }

  return { filesUpdated, filesSkipped, locations };
}
