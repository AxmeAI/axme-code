/**
 * AXME: Show Status — full-screen healthcheck webview.
 *
 * Old behaviour: command ran `axme-code status` and dumped text to the
 * Output channel. Users had to read raw markdown.
 *
 * New behaviour: webview panel with a structured table of every install
 * concern at a glance:
 *   - Extension version + Cursor host
 *   - Binary path + version (shells `axme-code --version`)
 *   - MCP server registration state (probed via `axme-code serve` stdio
 *     ping)
 *   - Hooks file path + axme entries count (parses ~/.cursor/hooks.json)
 *   - Auth mode + which provider is actually usable
 *   - Knowledge base stats per workspace folder (decisions, memories,
 *     safety rules)
 *   - Last audit timestamp (latest mtime in audit-worker-logs/)
 *
 * Each row has a status icon (✓ / ⚠ / ✗) and a one-line explanation.
 * The webview refreshes on demand via a "Refresh" button — no polling.
 */

import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { spawnBinary } from "./spawn-binary.js";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectIde } from "./ide-detect.js";
import { readCounts } from "./kb-watcher.js";
import { log } from "./log.js";

declare const __EXTENSION_VERSION__: string;

interface StatusRow {
  label: string;
  status: "ok" | "warn" | "fail";
  value: string;
  detail?: string;
}

async function exec(binary: string, args: string[], timeoutMs = 5000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawnBinary(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve({ stdout, stderr, code: null });
    }, timeoutMs);
    child.stdout!.on("data", (c) => (stdout += c.toString()));
    child.stderr!.on("data", (c) => (stderr += c.toString()));
    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.on("error", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: -1 });
    });
  });
}

async function collectRows(binary: string): Promise<StatusRow[]> {
  const rows: StatusRow[] = [];

  // 1. Extension
  rows.push({
    label: "Extension version",
    status: "ok",
    value: `v${__EXTENSION_VERSION__}`,
    detail: `Host IDE: ${detectIde()}`,
  });

  // 2. Binary
  if (!existsSync(binary)) {
    rows.push({ label: "Binary", status: "fail", value: "not found", detail: binary });
  } else {
    const { stdout, code } = await exec(binary, ["--version"]);
    rows.push({
      label: "Binary",
      status: code === 0 ? "ok" : "fail",
      value: code === 0 ? `v${stdout.trim()}` : "version probe failed",
      detail: binary,
    });
  }

  // 3. MCP server boot (initialize handshake, exit quickly)
  // Stdio mode requires we feed an initialize message. If the server answers,
  // it's healthy; if it crashes immediately, we'd see a non-zero exit.
  const mcpProbe = await probeMcp(binary);
  rows.push({
    label: "MCP server",
    status: mcpProbe.ok ? "ok" : "fail",
    value: mcpProbe.ok ? "responds to initialize" : "no response",
    detail: mcpProbe.detail,
  });

  // 4. Hooks
  const hooksPath = join(homedir(), ".cursor", "hooks.json");
  if (!existsSync(hooksPath)) {
    rows.push({ label: "Hooks", status: "fail", value: "not installed", detail: hooksPath });
  } else {
    try {
      const cfg = JSON.parse(readFileSync(hooksPath, "utf-8"));
      const axmeEntries: number[] = [];
      for (const kind of ["preToolUse", "postToolUse", "sessionEnd"] as const) {
        const arr: unknown = cfg.hooks?.[kind];
        if (!Array.isArray(arr)) {
          axmeEntries.push(0);
          continue;
        }
        const count = (arr as Array<{ command?: string }>).filter(
          (e) => String(e.command ?? "").includes("axme-code"),
        ).length;
        axmeEntries.push(count);
      }
      const all = axmeEntries.every((c) => c === 1);
      rows.push({
        label: "Hooks",
        status: all ? "ok" : "warn",
        value: all
          ? "preToolUse + postToolUse + sessionEnd"
          : `entries: pre=${axmeEntries[0]} post=${axmeEntries[1]} end=${axmeEntries[2]}`,
        detail: hooksPath,
      });
    } catch (err) {
      rows.push({ label: "Hooks", status: "fail", value: "parse error", detail: `${hooksPath}: ${(err as Error).message}` });
    }
  }

  // 5. Auth
  const authProbe = await exec(binary, ["auth", "status"]);
  if (authProbe.code !== 0) {
    rows.push({ label: "Auth", status: "fail", value: "axme-code auth status failed", detail: authProbe.stderr.slice(0, 200) });
  } else {
    const modeMatch = /Current mode:\s*(\S+)/m.exec(authProbe.stdout);
    if (!modeMatch) {
      rows.push({
        label: "Auth",
        status: "warn",
        value: "not configured (heuristic fallback)",
        detail: "Run `AXME: Reauth Auditor` to choose a credential",
      });
    } else {
      rows.push({
        label: "Auth",
        status: "ok",
        value: modeMatch[1],
        detail: "Run `AXME: Reauth Auditor` to switch provider",
      });
    }
  }

  // 6. KB per workspace folder
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    rows.push({ label: "Knowledge base", status: "warn", value: "no workspace open", detail: "Open a folder to see KB stats" });
  } else {
    for (const f of folders) {
      const root = f.uri.fsPath;
      const axmeDir = join(root, ".axme-code");
      if (!existsSync(axmeDir)) {
        rows.push({
          label: `KB · ${f.name}`,
          status: "warn",
          value: "not initialised",
          detail: `${axmeDir} missing — run \`AXME: Setup\``,
        });
        continue;
      }
      const counts = readCounts(root);
      const safetyRules = existsSync(join(axmeDir, "safety", "rules.yaml"));
      rows.push({
        label: `KB · ${f.name}`,
        status: "ok",
        value: `${counts.decisions} decisions, ${counts.memories} memories${safetyRules ? ", safety rules" : ""}`,
        detail: axmeDir,
      });

      // 7. Last audit (per workspace)
      const auditDir = join(axmeDir, "audit-worker-logs");
      if (existsSync(auditDir)) {
        const files = readdirSync(auditDir)
          .filter((n) => n.endsWith(".log"))
          .map((n) => ({ n, mtime: statSync(join(auditDir, n)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          const ageMin = Math.round((Date.now() - files[0].mtime) / 60000);
          rows.push({
            label: `Last audit · ${f.name}`,
            status: "ok",
            value: `${files.length} log${files.length === 1 ? "" : "s"}, latest ${ageMin}min ago`,
            detail: join(auditDir, files[0].n),
          });
        } else {
          rows.push({
            label: `Last audit · ${f.name}`,
            status: "warn",
            value: "no audit logs yet",
            detail: "Audit fires when a chat session ends",
          });
        }
      }
    }
  }

  return rows;
}

async function probeMcp(binary: string): Promise<{ ok: boolean; detail: string }> {
  const initMsg = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "axme-status", version: "0.0.2" } },
  });
  return new Promise((resolve) => {
    const child = spawnBinary(binary, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve({ ok: stdout.includes("\"protocolVersion\""), detail: stdout ? "partial response" : "timeout (5s)" });
    }, 5000);
    child.stdout!.on("data", (c) => {
      stdout += c.toString();
      if (stdout.includes("\"protocolVersion\"")) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        child.kill();
        resolve({ ok: true, detail: "stdio handshake ok" });
      }
    });
    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: false, detail: err.message });
    });
    child.stdin!.write(initMsg + "\n");
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderHtml(rows: StatusRow[]): string {
  const icon = (s: StatusRow["status"]) => (s === "ok" ? "✓" : s === "warn" ? "⚠" : "✗");
  const color = (s: StatusRow["status"]) =>
    s === "ok" ? "var(--vscode-charts-green)" : s === "warn" ? "var(--vscode-charts-yellow)" : "var(--vscode-errorForeground)";

  const tbody = rows
    .map(
      (r) => `
    <tr>
      <td class="icon" style="color: ${color(r.status)}">${icon(r.status)}</td>
      <td class="label">${escapeHtml(r.label)}</td>
      <td class="value">${escapeHtml(r.value)}</td>
      <td class="detail">${r.detail ? `<code>${escapeHtml(r.detail)}</code>` : ""}</td>
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 1em 2em; color: var(--vscode-foreground); }
    h1 { font-size: 1.4em; margin-bottom: 0.3em; }
    .timestamp { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 1em; }
    table { border-collapse: collapse; width: 100%; }
    th, td { padding: 0.5em 0.8em; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    th { background: var(--vscode-textBlockQuote-background); }
    .icon { font-size: 1.3em; width: 2em; text-align: center; }
    .label { font-weight: 500; width: 14em; }
    .value { width: 18em; }
    .detail code { font-size: 0.85em; color: var(--vscode-descriptionForeground); background: transparent; padding: 0; }
    button { margin-top: 1em; padding: 0.5em 1.2em; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; cursor: pointer; font-family: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <h1>AXME Code — status</h1>
  <div class="timestamp">As of ${new Date().toLocaleString()}</div>
  <table>
    <thead>
      <tr><th></th><th>Component</th><th>Status</th><th>Detail</th></tr>
    </thead>
    <tbody>${tbody}</tbody>
  </table>
  <button onclick="acquireVsCodeApi().postMessage({ command: 'refresh' })">Refresh</button>
</body>
</html>`;
}

let currentPanel: vscode.WebviewPanel | undefined;

export async function openStatusWebview(binary: string): Promise<void> {
  if (currentPanel) {
    currentPanel.reveal();
    await refresh(currentPanel, binary);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "axmeStatus",
    "AXME Code — Status",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  currentPanel = panel;
  panel.onDidDispose(() => { currentPanel = undefined; });
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.command === "refresh") await refresh(panel, binary);
  });
  await refresh(panel, binary);
}

async function refresh(panel: vscode.WebviewPanel, binary: string): Promise<void> {
  panel.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:2em;">Collecting status…</body></html>`;
  try {
    const rows = await collectRows(binary);
    panel.webview.html = renderHtml(rows);
  } catch (err) {
    log(`AXME: status webview refresh failed: ${(err as Error).message}`);
    panel.webview.html = `<!DOCTYPE html><html><body style="padding:2em;color:var(--vscode-errorForeground);">Failed to collect status: ${escapeHtml((err as Error).message)}</body></html>`;
  }
}
