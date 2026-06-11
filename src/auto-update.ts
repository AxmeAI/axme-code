/**
 * Auto-update for binary installs.
 *
 * On MCP server startup, checks GitHub releases API in background.
 * If a newer version exists, downloads the platform binary and replaces
 * the installed copy. The update takes effect on next VS Code reload.
 *
 * Skipped when: dev mode, not a binary install, checked within 24h,
 * or AXME_NO_UPDATE_CHECK env var is set.
 */

import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { AXME_CODE_VERSION } from "./types.js";

const REPO = "AxmeAI/axme-code";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const API_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const CONFIG_DIR = join(homedir(), ".config", "axme-code");
const CACHE_FILE = join(CONFIG_DIR, "update_check.json");

interface UpdateCache {
  checkedAt: string;
  latestVersion: string;
  latestTag: string;
  updated: boolean;
  updatedFrom?: string;
  updatedTo?: string;
}

// --- Server-process state ---

let updateNotification: string | null = null;

/** Return pending update notification for axme_context output (or null). */
export function getUpdateNotification(): string | null {
  return updateNotification;
}

// --- Helpers ---

function detectPlatform(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

function semverGreater(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Resolve the installed binary path (null if not a binary install).
 *
 * Binary installs run as `#!/usr/bin/env node /path/to/axme-code`
 * so process.argv[1] is the script without .js/.ts extension.
 */
function getBinaryPath(): string | null {
  const arg1 = process.argv[1];
  if (!arg1) return null;
  const resolved = resolve(arg1);
  const name = basename(resolved);
  // Binary install: filename is "axme-code" with no JS/TS extension
  if (name === "axme-code" && !resolved.endsWith(".js") && !resolved.endsWith(".ts")) {
    return resolved;
  }
  return null;
}

function readCache(): UpdateCache | null {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function fetchLatestRelease(): Promise<{ tag: string; version: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    // We publish two release tracks in one repo: `v*` (CLI binaries — what
    // this updater installs) and `extension-v*` (.vsix only). The
    // `/releases/latest` endpoint returns the most recently published
    // release overall, which flips to `extension-v*` whenever an extension
    // ships after a CLI release — semverGreater() then compares against NaN
    // and auto-update silently stops; if an extension version ever compared
    // greater, the download URL would 404. Same bug class as install.sh
    // (fixed in edc4724): fetch the list and pick the first `v[0-9]…` tag.
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `axme-code/${AXME_CODE_VERSION}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = (await resp.json()) as Array<{ tag_name: string }>;
    const tag = data.map(r => r.tag_name).find(t => /^v[0-9]/.test(t));
    if (!tag) return null;
    return { tag, version: tag.replace(/^v/, "") };
  } catch {
    return null;
  }
}

async function downloadBinary(tag: string, destPath: string): Promise<boolean> {
  const platform = detectPlatform();
  const url = `https://github.com/${REPO}/releases/download/${tag}/axme-code-${platform}`;
  const tmpPath = destPath + ".update-tmp";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!resp.ok || !resp.body) return false;
    const buffer = Buffer.from(await resp.arrayBuffer());
    writeFileSync(tmpPath, buffer);
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, destPath); // atomic replace
    return true;
  } catch {
    try { unlinkSync(tmpPath); } catch {}
    return false;
  }
}

// --- Public API ---

/**
 * Background auto-update check + install.
 * Called at server startup. Never throws, never blocks stdio.
 */
export async function backgroundAutoUpdate(): Promise<void> {
  try {
    // Skip in dev mode
    if (AXME_CODE_VERSION === "0.0.0-dev" || AXME_CODE_VERSION === "0.0.0") return;

    // Skip if disabled
    if (process.env.AXME_NO_UPDATE_CHECK) return;

    // Skip if not a binary install
    const binaryPath = getBinaryPath();
    if (!binaryPath) return;

    // Check cache - skip if checked recently
    const cache = readCache();
    if (cache?.checkedAt) {
      const age = Date.now() - new Date(cache.checkedAt).getTime();
      if (age < CHECK_INTERVAL_MS) {
        // Report previous update if pending reload
        if (cache.updated && cache.updatedTo) {
          updateNotification =
            `Auto-updated ${cache.updatedFrom} -> ${cache.updatedTo}. Reload VS Code to activate.`;
        }
        return;
      }
    }

    // Fetch latest release
    const latest = await fetchLatestRelease();
    if (!latest) {
      writeCache({
        checkedAt: new Date().toISOString(),
        latestVersion: AXME_CODE_VERSION,
        latestTag: `v${AXME_CODE_VERSION}`,
        updated: false,
      });
      return;
    }

    // Already up to date
    if (!semverGreater(latest.version, AXME_CODE_VERSION)) {
      writeCache({
        checkedAt: new Date().toISOString(),
        latestVersion: latest.version,
        latestTag: latest.tag,
        updated: false,
      });
      return;
    }

    // Download and replace binary
    const success = await downloadBinary(latest.tag, binaryPath);
    if (success) {
      updateNotification =
        `Auto-updated ${AXME_CODE_VERSION} -> ${latest.version}. Reload VS Code to activate.`;
      writeCache({
        checkedAt: new Date().toISOString(),
        latestVersion: latest.version,
        latestTag: latest.tag,
        updated: true,
        updatedFrom: AXME_CODE_VERSION,
        updatedTo: latest.version,
      });
    } else {
      writeCache({
        checkedAt: new Date().toISOString(),
        latestVersion: latest.version,
        latestTag: latest.tag,
        updated: false,
      });
    }
  } catch (err) {
    // Never crash the server due to update logic.
    // Report to telemetry so we can see auto-update failures in aggregate.
    try {
      const { reportError, classifyError } = await import("./telemetry.js");
      reportError("auto_update", classifyError(err), false);
    } catch { /* swallow */ }
  }
}
