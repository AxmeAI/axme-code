/**
 * StorageEngine - safe filesystem operations for .axme-code/ storage.
 *
 * Features:
 * - Atomic writes: write to temp file, then rename (prevents corruption on crash)
 * - Buffered append: for JSONL files (worklog)
 * - Directory auto-creation
 * - Read with graceful fallback
 */

import {
  writeFileSync,
  writeSync,
  readFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Atomically write a file: write to temp, then rename.
 * Ensures the file is never partially written.
 */
export function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  try {
    // Write and fsync through the same writable fd. Windows' FlushFileBuffers
    // (Node maps fsyncSync to it) requires write access on the handle — a
    // read-only fd returns EPERM. POSIX allows fsync on any fd, so the write-
    // fd pattern is correct on both platforms.
    const fd = openSync(tmpPath, "w");
    try {
      writeSync(fd, Buffer.from(content, "utf-8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Append a line to a file (for JSONL worklog).
 * Creates file and directories if needed.
 */
export function appendLine(filePath: string, line: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  // Use fd-based write + fsync for durability on SIGKILL.
  const fd = openSync(filePath, "a");
  try {
    const buf = Buffer.from(line + "\n", "utf-8");
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a file, returning empty string if missing.
 */
export function readSafe(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Read and parse a JSON file, returning null if missing or invalid.
 */
export function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Atomically write a JSON file with pretty formatting.
 */
export function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Ensure a directory exists.
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

/**
 * Check if a path exists.
 */
export function pathExists(filePath: string): boolean {
  return existsSync(filePath);
}

/**
 * List files in a directory matching a filter.
 */
export function listFiles(dirPath: string, filter?: (name: string) => boolean): string[] {
  try {
    const entries = readdirSync(dirPath);
    return filter ? entries.filter(filter) : entries;
  } catch {
    return [];
  }
}

/**
 * Check if path is a directory.
 */
export function isDir(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Delete a file if it exists.
 */
export function removeFile(filePath: string): boolean {
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
