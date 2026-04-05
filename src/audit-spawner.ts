/**
 * Detached audit worker spawner.
 *
 * Spawns a standalone `axme-code audit-session --workspace X --session Y`
 * child process that is fully decoupled from its parent. The worker lives in
 * its own process group (setsid via `detached: true`), so SIGTERM/SIGKILL
 * delivered to the parent's process group does NOT propagate to it. The
 * parent returns in milliseconds; the worker runs to completion on its own.
 *
 * This is the one architectural fix that unblocks the entire audit pipeline:
 *
 *   Before: runSessionCleanup runs synchronously inside the MCP server
 *   (on transport close) or inside the session-end hook subprocess. Both
 *   are children of Claude Code, which VS Code can kill at any moment —
 *   side panel mode gives them a few seconds, center editor tab mode kills
 *   them immediately. Large audits take 30-120s. Audits die mid-run.
 *
 *   After: runSessionCleanup runs inside a detached child that VS Code does
 *   not know about. Parent exits in <10ms (well within any timeout). The
 *   child reads fresh code from dist/ on every invocation, so iteration on
 *   the auditor takes effect immediately without window reload.
 *
 * The worker redirects stdout/stderr to a per-session log file under
 * .axme-code/audit-worker-logs/<sessionId>.log so operators can inspect
 * what happened post-mortem.
 */

import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./storage/engine.js";
import { AXME_CODE_DIR } from "./types.js";

const AUDIT_WORKER_LOGS_DIR = "audit-worker-logs";

/**
 * Spawn a detached audit worker for the given session. Returns immediately
 * after the child is spawned; does not wait for it to finish.
 *
 * The child inherits:
 *   - The current `process.execPath` (same Node binary)
 *   - The current CLI script path (`process.argv[1]`, i.e. dist/axme-code.js)
 *   - A copy of `process.env` plus `AXME_SKIP_HOOKS=1` so any subclaude the
 *     audit spawns does not create ghost AXME sessions via its hooks
 *
 * The child does NOT inherit:
 *   - stdin (set to 'ignore' — the worker reads nothing from stdin)
 *   - stdout/stderr from parent (redirected to the log file instead — the
 *     parent may be exiting imminently and holding a pipe fd open would
 *     kill the writer once the reader closes)
 */
export function spawnDetachedAuditWorker(workspacePath: string, sessionId: string): void {
  const logsDir = join(workspacePath, AXME_CODE_DIR, AUDIT_WORKER_LOGS_DIR);
  ensureDir(logsDir);
  const logPath = join(logsDir, `${sessionId}.log`);

  // Open the log file ourselves and pass the raw fd to the child. 'a' mode
  // appends across restarts, so repeated audits of the same session leave
  // a cumulative history in one file.
  const fd = openSync(logPath, "a");

  try {
    const cliPath = process.argv[1]; // the axme-code bin that started us
    const child = spawn(
      process.execPath,
      [cliPath, "audit-session", "--workspace", workspacePath, "--session", sessionId],
      {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, AXME_SKIP_HOOKS: "1" },
      },
    );
    child.unref();
    process.stderr.write(
      `AXME: spawned detached audit worker pid=${child.pid} session=${sessionId} log=${logPath}\n`,
    );
  } finally {
    // The child now holds its own dup of the fd; we can close our copy.
    // This is important: if we leave the fd open in the parent and the
    // parent exits via process.exit(), the fd is closed anyway, but
    // explicit close keeps fd accounting clean for tests.
    try { closeSync(fd); } catch {}
  }
}
