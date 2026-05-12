/**
 * AXME sidebar (Activity Bar webview).
 *
 * Always-visible dashboard for the AXME extension. Replaces the corner
 * notification toast and the on-demand status webview as the primary
 * surface for activation state, KB counters, backlog, and per-session
 * monitoring. Sections render top-down with VS Code's theme variables so
 * the visual style follows the user's chosen colour scheme.
 *
 * The provider class owns the WebviewView lifecycle: it builds the HTML
 * once on resolve(), then pushes state diffs via postMessage as KB files
 * change or commands fire. It does not poll — KbWatcher and the activation
 * report drive updates. The webview only sends messages back when the user
 * clicks a button (run setup, close session, add backlog item, etc.).
 */

import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KbWatcher, KbCounts, readCounts } from "./kb-watcher.js";
import { readBacklog, BacklogItemLite } from "./backlog-reader.js";
import { readActiveSession, ActiveSession } from "./session-tracker.js";
import { detectCurrentMode } from "./auditor-auth.js";
import { log } from "./log.js";

/**
 * Sidebar polling interval for the session block. Three seconds is the
 * sweet spot between "follows chat-tab switches within a few seconds" and
 * "doesn't peg a Node thread reading transcript files for a webview the
 * user isn't currently looking at". Polling is paused entirely when the
 * webview view is hidden — see onDidChangeVisibility wiring below.
 */
const SESSION_POLL_MS = 3_000;

/** Threshold above which we warn the user to close the session. Chosen
 * to match the upper end of Cursor's reported auto-summarize trigger
 * (~50–60% of context window for 200k models) so the user has a chance
 * to close cleanly via our handoff flow BEFORE Cursor's lossy condense
 * fires. */
const SESSION_WARN_TOKENS = 200_000;

export interface SidebarState {
  /** Is the workspace initialised (`.axme-code/` exists)? */
  setupDone: boolean;
  /** Live KB counts (memories / decisions / safety / backlog / questions). */
  counts: KbCounts;
  /** Top backlog items for the inline list (~5 shown). */
  backlog: BacklogItemLite[];
  /** Auditor mode from settings. */
  auditorMode: "off" | "cooperative" | "background";
  /** True when background mode is selected AND a credential is saved. */
  auditorKeyConfigured: boolean;
  /** Did hooks install successfully at activation? */
  hooksOk: boolean;
  /** Are we running in Cursor (vs other host)? */
  isCursor: boolean;
  /** Live snapshot of the active chat session — tokens, messages, age. */
  session: ActiveSession | null;
  /** Warn threshold (passed to webview so it can hide its own UI). */
  warnTokens: number;
}

export type SidebarMessage =
  | { type: "command"; commandId: string }
  | { type: "setAuditorMode"; mode: SidebarState["auditorMode"] }
  | { type: "openFile"; path: string };

/**
 * The provider is a singleton owned by activate(). It is constructed before
 * the user opens the AXME view — VS Code calls resolveWebviewView() lazily
 * when the view first becomes visible. Any state that arrives before that
 * point is buffered into `pendingState`.
 */
export class AxmeSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "axme.monitor";

  private view: vscode.WebviewView | undefined;
  private kbWatcher: KbWatcher | undefined;
  private workspaceRoot: string | undefined;
  private pendingState: Partial<SidebarState> = {};
  private binary: string | undefined;

  private sessionPoll: NodeJS.Timeout | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly initialState: Omit<SidebarState, "counts" | "backlog" | "auditorKeyConfigured" | "session" | "warnTokens">,
  ) {}

  attach(workspaceRoot: string | undefined, binary: string): void {
    this.workspaceRoot = workspaceRoot;
    this.binary = binary;
    if (workspaceRoot) {
      this.kbWatcher = new KbWatcher();
      // Counters + backlog list refresh together — both react to file
      // changes under .axme-code/, and the watcher already debounces.
      this.kbWatcher.attach(workspaceRoot, (counts) => {
        this.push({ counts, backlog: readBacklog(workspaceRoot).slice(0, 5) });
      });
    }
    // Fire-and-forget auditor credential probe so the sidebar can render
    // the "Configure credential…" banner accurately on first open.
    void this.refreshAuthState();
  }

  async refreshAuthState(): Promise<void> {
    if (!this.binary) return;
    const mode = await detectCurrentMode(this.binary).catch(() => undefined);
    this.push({ auditorKeyConfigured: !!mode });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((m: SidebarMessage) => this.onMessage(m));

    // Push the initial snapshot once webview is alive.
    const counts = this.workspaceRoot ? readCounts(this.workspaceRoot) : emptyCounts();
    const backlog = this.workspaceRoot ? readBacklog(this.workspaceRoot).slice(0, 5) : [];
    this.push({ ...this.initialState, counts, backlog, warnTokens: SESSION_WARN_TOKENS, ...this.pendingState });
    this.pendingState = {};

    // Session polling — only runs while the view is visible. VS Code fires
    // onDidChangeVisibility when the user collapses the sidebar / switches
    // to another Activity Bar view; we stop the timer to avoid wasted reads
    // and restart on next reveal.
    const ensurePolling = () => {
      if (webviewView.visible && !this.sessionPoll) {
        this.refreshSession();
        this.sessionPoll = setInterval(() => this.refreshSession(), SESSION_POLL_MS);
      } else if (!webviewView.visible && this.sessionPoll) {
        clearInterval(this.sessionPoll);
        this.sessionPoll = undefined;
      }
    };
    ensurePolling();
    webviewView.onDidChangeVisibility(ensurePolling);
    webviewView.onDidDispose(() => {
      if (this.sessionPoll) { clearInterval(this.sessionPoll); this.sessionPoll = undefined; }
    });
  }

  private refreshSession(): void {
    if (!this.workspaceRoot) return;
    try {
      const s = readActiveSession(this.workspaceRoot);
      this.push({ session: s });
    } catch { /* swallow — non-fatal */ }
  }

  /**
   * Update one or more fields of the sidebar state. Safe to call before the
   * view is resolved — values get buffered and flushed on resolve.
   */
  push(state: Partial<SidebarState>): void {
    if (!this.view) {
      this.pendingState = { ...this.pendingState, ...state };
      return;
    }
    void this.view.webview.postMessage({ type: "state", state });
  }

  dispose(): void {
    this.kbWatcher?.dispose();
    if (this.sessionPoll) { clearInterval(this.sessionPoll); this.sessionPoll = undefined; }
  }

  private onMessage(m: SidebarMessage): void {
    log(`sidebar message: ${m.type}`);
    switch (m.type) {
      case "command":
        void vscode.commands.executeCommand(m.commandId);
        break;
      case "setAuditorMode":
        void vscode.workspace
          .getConfiguration("axme")
          .update("auditorMode", m.mode, vscode.ConfigurationTarget.Global);
        this.push({ auditorMode: m.mode });
        // Switching INTO background mode without a saved credential is the
        // moment the user actually wants to paste a key — trigger the auth
        // command so the input flow happens right then instead of forcing
        // them to find the Configure button.
        if (m.mode === "background") {
          void (async () => {
            const probe = this.binary
              ? await detectCurrentMode(this.binary).catch(() => undefined)
              : undefined;
            if (!probe) {
              await vscode.commands.executeCommand("axme.reauthAuditor");
              await this.refreshAuthState();
            }
          })();
        }
        break;
      case "openFile":
        void vscode.workspace.openTextDocument(m.path).then((d) => vscode.window.showTextDocument(d));
        break;
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    // We inline the HTML rather than loading a separate file so the
    // extension bundle stays single-file. CSS uses VS Code's theme tokens
    // (var(--vscode-*)) so dark/light/high-contrast all just work.
    const nonce = makeNonce();
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}';`;

    return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>${SIDEBAR_CSS}</style>
</head>
<body>
  <section id="header">
    <div class="title">AXME Code</div>
    <div id="setup-pill" class="pill"></div>
  </section>

  <section id="setup-section" class="section"></section>
  <section id="hooks-section" class="section"></section>
  <section id="auditor-section" class="section"></section>
  <section id="counters-section" class="section"></section>
  <section id="backlog-section" class="section"></section>
  <section id="session-section" class="section"></section>

  <footer>
    <button class="link" data-cmd="axme.showStatus">Healthcheck…</button>
    <button class="link" data-cmd="axme.reindex">Reindex</button>
    <button class="link" data-cmd="axme.reset">Reset</button>
  </footer>

  <script nonce="${nonce}">${SIDEBAR_JS}</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  return Array.from({ length: 16 }, () => Math.random().toString(36).slice(2, 4)).join("");
}

function emptyCounts(): KbCounts {
  return { memories: 0, decisions: 0, safety: 0, backlog: 0, questions: 0 };
}

const SIDEBAR_CSS = `
:root {
  --gap: 10px;
  --pad: 12px;
  --radius: 4px;
}
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: transparent;
  padding: 0;
  margin: 0;
}
#header {
  padding: var(--pad);
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.title { font-weight: 600; font-size: 13px; }
.pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
.pill.ok    { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
.pill.warn  { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
.pill.error { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
.section {
  padding: var(--pad);
  border-bottom: 1px solid var(--vscode-panel-border);
}
.section h3 {
  margin: 0 0 6px 0;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.7;
}
.row { display: flex; justify-content: space-between; padding: 2px 0; }
.row .k { opacity: 0.75; }
.row .v { font-weight: 500; }
button {
  font-family: inherit;
  font-size: var(--vscode-font-size);
  padding: 4px 10px;
  margin: 4px 4px 4px 0;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: var(--radius);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.link {
  background: transparent;
  color: var(--vscode-textLink-foreground);
  border: none;
  padding: 2px 6px;
  text-decoration: underline;
}
.warning-banner {
  margin: 8px 0 4px;
  padding: 8px;
  border-left: 3px solid var(--vscode-editorWarning-foreground);
  background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, 0.08));
  font-size: 12px;
}
.error-banner {
  margin: 8px 0 4px;
  padding: 8px;
  border-left: 3px solid var(--vscode-errorForeground);
  background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.08));
  font-size: 12px;
}
footer {
  padding: var(--pad);
  display: flex;
  gap: 4px;
}
select, input[type=text], input[type=password] {
  font-family: inherit;
  font-size: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: var(--radius);
  padding: 4px 6px;
  width: 100%;
  box-sizing: border-box;
}
.muted { opacity: 0.6; font-size: 11px; }
.bl-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 12px;
}
.bl-row:hover { background: var(--vscode-list-hoverBackground); }
.bl-dot { flex: 0 0 auto; }
.bl-title {
  flex: 1 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;

const SIDEBAR_JS = `
const vscode = acquireVsCodeApi();
let S = { setupDone: false, counts: { memories:0, decisions:0, safety:0, backlog:0, questions:0 }, backlog: [], auditorMode: "cooperative", auditorKeyConfigured: false, hooksOk: false, isCursor: true, session: null, warnTokens: 200000 };

function formatDuration(ms) {
  if (ms <= 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return h + "h " + (rm ? rm + "m" : "");
}
function formatTokens(n) {
  if (n < 1000) return n + "";
  if (n < 100000) return (n / 1000).toFixed(1).replace(/\\.0$/, "") + "k";
  return Math.round(n / 1000) + "k";
}

function send(msg) { vscode.postMessage(msg); }
function cmd(id)  { send({ type: "command", commandId: id }); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function render() {
  // Setup pill
  const pill = document.getElementById("setup-pill");
  if (S.setupDone) { pill.textContent = "ready"; pill.className = "pill ok"; }
  else { pill.textContent = "setup required"; pill.className = "pill warn"; }

  // Setup section
  const setup = document.getElementById("setup-section");
  if (S.setupDone) {
    setup.innerHTML = '<h3>Workspace</h3><div class="row"><span class="k">Status</span><span class="v">Initialised</span></div>';
  } else {
    setup.innerHTML = \`
      <h3>Setup</h3>
      <div class="warning-banner">
        Workspace not initialised. AXME tools won't load context without a knowledge base.
      </div>
      <button data-cmd="axme.setup">Run setup (with API key)</button>
      <button class="secondary" data-cmd="axme.askAgentSetup">Ask agent to setup</button>
    \`;
  }

  // Hooks section
  const hooks = document.getElementById("hooks-section");
  hooks.innerHTML = \`
    <h3>Safety hooks</h3>
    <div class="row"><span class="k">~/.cursor/hooks.json</span><span class="v">\${S.hooksOk ? "active" : "missing"}</span></div>
    \${S.hooksOk ? "" : '<button class="secondary" data-cmd="axme.reinstallHooks">Reinstall hooks</button>'}
  \`;

  // Auditor section
  const audit = document.getElementById("auditor-section");
  const needsKey = S.auditorMode === "background" && !S.auditorKeyConfigured;
  audit.innerHTML = \`
    <h3>Session auditor</h3>
    <div class="row"><span class="k">Mode</span></div>
    <select id="auditor-mode">
      <option value="off"\${S.auditorMode==="off"?" selected":""}>Off — no extraction</option>
      <option value="cooperative"\${S.auditorMode==="cooperative"?" selected":""}>Cooperative — agent saves inline (no extra cost)</option>
      <option value="background"\${S.auditorMode==="background"?" selected":""}>Background — separate LLM after each chat</option>
    </select>
    <p class="muted">Cooperative uses your Cursor subscription. Background runs a separate LLM after every chat using your own API key (billed separately).</p>
    \${needsKey ? '<div class="warning-banner">Background mode is selected but no credential is configured. The session-end auditor will not run.</div>' : ""}
    \${S.auditorMode==="background" ? \`<button class="secondary" data-cmd="axme.reauthAuditor">\${S.auditorKeyConfigured ? "Change credential…" : "Configure credential…"}</button>\` : ""}
  \`;

  // Counters
  const c = S.counts;
  const counters = document.getElementById("counters-section");
  counters.innerHTML = \`
    <h3>Knowledge base</h3>
    <div class="row"><span class="k">Memories</span><span class="v">\${c.memories}</span></div>
    <div class="row"><span class="k">Decisions</span><span class="v">\${c.decisions}</span></div>
    <div class="row"><span class="k">Safety rules</span><span class="v">\${c.safety}</span></div>
    <div class="row"><span class="k">Open questions</span><span class="v">\${c.questions}</span></div>
  \`;

  // Backlog list — top 5 by status/priority/recency, see backlog-reader.ts.
  const bl = S.backlog || [];
  const dot = (pri) => pri === "high" ? "🔴" : pri === "medium" ? "🟡" : "🟢";
  const lbl = (st) => st === "in-progress" ? "[wip] " : st === "blocked" ? "[blk] " : "";
  const rows = bl.length === 0
    ? '<p class="muted">No items yet. Use [+ Add] or ask the agent to triage.</p>'
    : bl.map((b) => \`
        <div class="bl-row" data-path="\${b.path}">
          <span class="bl-dot">\${dot(b.priority)}</span>
          <span class="bl-title">\${lbl(b.status)}\${escapeHtml(b.id + ": " + b.title)}</span>
        </div>
      \`).join("");
  document.getElementById("backlog-section").innerHTML = \`
    <h3>Backlog (\${c.backlog} total)</h3>
    \${rows}
    <button class="secondary" data-cmd="axme.addBacklogItem">+ Add item</button>
    <button class="link" data-cmd="axme.openBacklog">Open folder</button>
  \`;
  document.querySelectorAll(".bl-row").forEach((el) => {
    el.addEventListener("click", () => send({ type: "openFile", path: el.getAttribute("data-path") }));
  });

  // Live session block — driven by readActiveSession on the host side.
  const sess = S.session;
  let sessionHtml = '<p class="muted">No active chat detected. Tools will record activity when an MCP call lands.</p>';
  if (sess && sess.hasData) {
    const startedMs = Date.parse(sess.startedAt);
    const ageMs = Number.isFinite(startedMs) ? Date.now() - startedMs : 0;
    const overWarn = sess.tokens >= S.warnTokens;
    sessionHtml = \`
      <div class="row"><span class="k">Started</span><span class="v">\${formatDuration(ageMs)} ago</span></div>
      <div class="row"><span class="k">Tokens</span><span class="v">\${formatTokens(sess.tokens)}</span></div>
      <div class="row"><span class="k">Messages</span><span class="v">\${sess.messages}</span></div>
      \${overWarn ? \`
        <div class="warning-banner">
          Approaching Cursor's auto-summarize threshold. Cursor will compress
          your conversation around here and quality often degrades after that.
          Close cleanly via handoff to preserve all decisions and memories.
        </div>\` : ""}
    \`;
  } else if (sess) {
    sessionHtml = \`
      <p class="muted">Session \${escapeHtml(sess.axmeSessionId.slice(0, 8))} just started — transcript empty.</p>
    \`;
  }
  document.getElementById("session-section").innerHTML = \`
    <h3>Current session</h3>
    \${sessionHtml}
    <button data-cmd="axme.closeSession">Close session (handoff)</button>
  \`;

  // Wire dynamic handlers (re-bound on every render — small DOM, cheap).
  document.querySelectorAll("[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", () => cmd(btn.getAttribute("data-cmd")));
  });
  const sel = document.getElementById("auditor-mode");
  if (sel) sel.addEventListener("change", (e) => send({ type: "setAuditorMode", mode: e.target.value }));
}

window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "state") {
    S = { ...S, ...e.data.state };
    render();
  }
});

render();
`;
