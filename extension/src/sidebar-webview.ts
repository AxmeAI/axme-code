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
import { readHealth, HealthSnapshot } from "./health-reader.js";
import { detectCurrentMode } from "./auditor-auth.js";
import { hooksAreInstalled } from "./hooks-state.js";
import { log } from "./log.js";

/**
 * Sidebar polling interval for the session block. Three seconds is the
 * sweet spot between "follows chat-tab switches within a few seconds" and
 * "doesn't peg a Node thread reading transcript files for a webview the
 * user isn't currently looking at". Polling is paused entirely when the
 * webview view is hidden — see onDidChangeVisibility wiring below.
 */
const SESSION_POLL_MS = 3_000;

// (Old SESSION_WARN_TOKENS dropped — we no longer display a token number
//  in the session block. See "Live session block" comment in the render
//  code for the rationale. Threshold is now message-count + duration in
//  the render code itself: >50 messages OR >2h triggers the warning.)

export interface SidebarState {
  /** Is the workspace initialised (`.axme-code/` exists)? */
  setupDone: boolean;
  /** Live KB counts (memories / decisions / safety / backlog / questions). */
  counts: KbCounts;
  /** Top backlog items for the inline list (~5 shown). */
  backlog: BacklogItemLite[];
  /** Auditor mode from settings. */
  auditorMode: "cooperative" | "background";
  /** True when background mode is selected AND a credential is saved. */
  auditorKeyConfigured: boolean;
  /** Did hooks install successfully at activation? */
  hooksOk: boolean;
  /** Are we running in Cursor (vs other host)? */
  isCursor: boolean;
  /** Live snapshot of the active chat session — messages, age (tokens are
   *  collected but no longer displayed; see "Live session block" comment
   *  in the render code for the rationale). */
  session: ActiveSession | null;
  /** KB health signals — pending audits, last error, last handoff. */
  health: HealthSnapshot;
}

export type SidebarMessage =
  | { type: "command"; commandId: string }
  | { type: "setAuditorMode"; mode: SidebarState["auditorMode"] }
  | { type: "openFile"; path: string }
  | { type: "backlogStatus"; id: string };

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
    private readonly initialState: Omit<SidebarState, "counts" | "backlog" | "auditorKeyConfigured" | "session" | "health">,
  ) {}

  attach(workspaceRoot: string | undefined, binary: string): void {
    this.workspaceRoot = workspaceRoot;
    this.binary = binary;
    if (workspaceRoot) {
      this.kbWatcher = new KbWatcher();
      // Counters + backlog list refresh together — both react to file
      // changes under .axme-code/, and the watcher already debounces.
      // onCreated fires when .axme-code/ appears mid-session (e.g. the
      // agent just performed cooperative setup); we use it to flip the
      // sidebar pill to "ready" AND drive the walkthrough step-2
      // completion key. Without this, neither the sidebar nor the
      // Getting Started walkthrough would notice that setup completed
      // until the next window reload.
      this.kbWatcher.attach(
        workspaceRoot,
        (counts) => {
          // KB-content changes typically coincide with health changes
          // (a saved memory means a session is in-flight, etc.), so we
          // refresh both together on the watcher tick — saves wiring a
          // second polling timer.
          this.push({
            counts,
            backlog: readBacklog(workspaceRoot).slice(0, 5),
            health: readHealth(workspaceRoot),
          });
        },
        () => {
          this.push({ setupDone: true, health: readHealth(workspaceRoot) });
          void vscode.commands.executeCommand(
            "setContext",
            "axme.workspaceInitialized",
            true,
          );
          log("KbWatcher: .axme-code/ created — sidebar + walkthrough updated.");
        },
      );
    }
    // Push the live disk state for hooks. This overrides the activation
    // report's snapshot (which can be stale after a reinstall or after
    // installUserHooks's first-run race).
    this.push({ hooksOk: hooksAreInstalled() });
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

    // Push the initial snapshot once webview is alive. Hooks state is
    // read from disk on every reveal so reinstalls / external edits to
    // ~/.cursor/hooks.json show up the next time the sidebar comes into
    // view, not just at activation time.
    const counts = this.workspaceRoot ? readCounts(this.workspaceRoot) : emptyCounts();
    const backlog = this.workspaceRoot ? readBacklog(this.workspaceRoot).slice(0, 5) : [];
    const health = this.workspaceRoot ? readHealth(this.workspaceRoot) : { pendingAudits: 0 };
    this.push({
      ...this.initialState,
      counts,
      backlog,
      health,
      hooksOk: hooksAreInstalled(),
      ...this.pendingState,
    });
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
      case "backlogStatus":
        void vscode.commands.executeCommand("axme.changeBacklogStatus", m.id);
        break;
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    // We inline the HTML rather than loading a separate file so the
    // extension bundle stays single-file. CSS uses VS Code's theme tokens
    // (var(--vscode-*)) so dark/light/high-contrast all just work.
    const nonce = makeNonce();
    // Per-project header: AXME is per-repo, and the sidebar should make
    // it obvious WHICH repo the current numbers / setup state belong to.
    // VS Code reloads the window on folder switch, so this static bake
    // is safe — the webview's lifetime equals one workspace's lifetime.
    const projectName = this.workspaceRoot
      ? this.workspaceRoot.split("/").filter(Boolean).pop() ?? ""
      : "";
    const titleHtml = projectName
      ? `AXME · ${escapeHtmlServer(projectName)}`
      : `AXME Code`;
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
    <div class="title">${titleHtml}</div>
    <div id="setup-pill" class="pill"></div>
  </section>

  <section id="setup-section" class="section"></section>
  <section id="health-section" class="section"></section>
  <section id="hooks-section" class="section"></section>
  <section id="auditor-section" class="section"></section>
  <section id="counters-section" class="section"></section>
  <section id="backlog-section" class="section"></section>
  <section id="session-section" class="section"></section>

  <footer>
    <button class="link" data-cmd="axme.showStatus">Healthcheck…</button>
  </footer>
  <!--
    Reindex / Reset removed from the sidebar footer per user feedback —
    they ran a destructive or hard-to-undo flow without enough visible
    feedback inline. The commands stay registered and accessible via
    the Command Palette (AXME: Reindex semantic search / AXME: Reset),
    where the modal-driven flow is more obviously a deliberate action.
  -->

  <script nonce="${nonce}">${SIDEBAR_JS}</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  return Array.from({ length: 16 }, () => Math.random().toString(36).slice(2, 4)).join("");
}

/**
 * Tiny HTML-escape for values we bake into the static template (project
 * name in the header). Webview JS uses its own escapeHtml — we duplicate
 * here because the JS one lives inside a template literal as plain
 * source, not a callable from the host.
 */
function escapeHtmlServer(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
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
.kb-row {
  cursor: pointer;
  padding: 3px 4px;
  border-radius: var(--radius);
}
.kb-row:hover { background: var(--vscode-list-hoverBackground); }
.bl-menu {
  opacity: 0.5;
  padding: 0 6px;
  cursor: pointer;
  font-size: 14px;
  letter-spacing: 1px;
  user-select: none;
}
.bl-menu:hover { opacity: 1; background: var(--vscode-list-hoverBackground); border-radius: var(--radius); }
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
let S = { setupDone: false, counts: { memories:0, decisions:0, safety:0, backlog:0, questions:0 }, backlog: [], auditorMode: "cooperative", auditorKeyConfigured: false, hooksOk: false, isCursor: true, session: null, health: { pendingAudits: 0 } };

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
// formatTokens was used by the old Tokens row in the session block.
// Variant B dropped that row — function removed to keep dead code out.

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
        AXME is per-project. This repo needs setup:
      </div>
      <button data-cmd="axme.askAgentSetup">Ask agent to setup</button>
      <button class="secondary" data-cmd="axme.setup">Run setup (with API key)</button>
    \`;
  }

  // Health section — pending audits, last audit error, last handoff.
  // Only renders when there's something to say (don't add visual noise
  // for a healthy KB).
  const h = S.health || { pendingAudits: 0 };
  const healthBits = [];
  if (h.pendingAudits > 0) {
    healthBits.push(\`
      <div class="warning-banner">
        \${h.pendingAudits} background audit\${h.pendingAudits > 1 ? "s" : ""} still running —
        the knowledge base may be missing the latest extractions until they finish.
      </div>
    \`);
  }
  if (h.lastAuditError) {
    healthBits.push(\`
      <div class="error-banner">
        Last audit failed: \${escapeHtml(h.lastAuditError.message)}
        <button class="link" data-cmd="axme.showAuditLog">Show audit log</button>
      </div>
    \`);
  }
  if (h.lastHandoffPath) {
    const ageMin = h.lastHandoffAgeMs ? Math.floor(h.lastHandoffAgeMs / 60000) : 0;
    const ageText = ageMin < 60 ? \`\${ageMin}m\` : ageMin < 1440 ? \`\${Math.floor(ageMin/60)}h\` : \`\${Math.floor(ageMin/1440)}d\`;
    healthBits.push(\`
      <div class="row kb-row" data-cmd="axme.showLastHandoff">
        <span class="k">Last handoff</span><span class="v">\${ageText} ago →</span>
      </div>
    \`);
  }
  const healthEl = document.getElementById("health-section");
  if (healthBits.length === 0) {
    healthEl.innerHTML = "";
    healthEl.style.display = "none";
  } else {
    healthEl.style.display = "";
    healthEl.innerHTML = \`<h3>Status</h3>\${healthBits.join("")}\`;
  }

  // Hooks section
  const hooks = document.getElementById("hooks-section");
  hooks.innerHTML = \`
    <h3>Safety hooks</h3>
    <div class="row"><span class="k">~/.cursor/hooks.json</span><span class="v">\${S.hooksOk ? "active" : "missing"}</span></div>
    \${S.hooksOk ? "" : '<p class="muted">Hooks failed at activation. Use AXME: Reset to clear state and reinstall the extension.</p>'}
  \`;

  // Auditor section
  const audit = document.getElementById("auditor-section");
  const needsKey = S.auditorMode === "background" && !S.auditorKeyConfigured;
  audit.innerHTML = \`
    <h3>Session auditor</h3>
    <div class="row"><span class="k">Mode</span></div>
    <select id="auditor-mode">
      <option value="cooperative"\${S.auditorMode==="cooperative"?" selected":""}>Cooperative — agent saves inline (no extra cost)</option>
      <option value="background"\${S.auditorMode==="background"?" selected":""}>Background — separate LLM, extra cost (uses your API key)</option>
    </select>
    <p class="muted">Cooperative: when you wrap up, ask the agent to close the session — it will extract memories / decisions / safety inline before you start a fresh chat. Background: a detached LLM runs after every chat-end (your API key, billed separately).</p>
    \${needsKey ? '<div class="warning-banner">Background mode is selected but no credential is configured. The session-end auditor will not run.</div>' : ""}
    \${S.auditorMode==="background" ? \`<button class="secondary" data-cmd="axme.reauthAuditor">\${S.auditorKeyConfigured ? "Change credential…" : "Configure credential…"}</button>\` : ""}
  \`;

  // Counters — clickable. Each row routes to a command that reveals the
  // corresponding folder (memories/decisions) or opens the single file
  // (safety rules YAML / open-questions markdown) in the editor.
  const c = S.counts;
  const counters = document.getElementById("counters-section");
  counters.innerHTML = \`
    <h3>Knowledge base</h3>
    <div class="row kb-row" data-cmd="axme.openMemoryFolder">
      <span class="k">Memories</span><span class="v">\${c.memories}</span>
    </div>
    <div class="row kb-row" data-cmd="axme.openDecisionsFolder">
      <span class="k">Decisions</span><span class="v">\${c.decisions}</span>
    </div>
    <div class="row kb-row" data-cmd="axme.openSafetyRules">
      <span class="k">Safety rules</span><span class="v">\${c.safety}</span>
    </div>
    <div class="row kb-row" data-cmd="axme.openQuestions">
      <span class="k">Open questions</span><span class="v">\${c.questions}</span>
    </div>
  \`;

  // Backlog list — top 5 by status/priority/recency, see backlog-reader.ts.
  // Each row: priority dot + title + a tiny "•••" mini-button that opens
  // a QuickPick (on the host side) to change status. Row body click
  // still opens the .md in the editor.
  const bl = S.backlog || [];
  const dot = (pri) => pri === "high" ? "🔴" : pri === "medium" ? "🟡" : "🟢";
  const lbl = (st) => st === "in-progress" ? "[wip] " : st === "blocked" ? "[blk] " : "";
  const rows = bl.length === 0
    ? '<p class="muted">No items yet. Use [+ Add] or ask the agent to triage.</p>'
    : bl.map((b) => \`
        <div class="bl-row" data-path="\${b.path}" data-id="\${b.id}">
          <span class="bl-dot">\${dot(b.priority)}</span>
          <span class="bl-title">\${lbl(b.status)}\${escapeHtml(b.id + ": " + b.title)}</span>
          <span class="bl-menu" data-bl-menu="\${b.id}" title="Change status">⋯</span>
        </div>
      \`).join("");
  document.getElementById("backlog-section").innerHTML = \`
    <h3>Backlog (\${c.backlog} total)</h3>
    \${rows}
    <button class="secondary" data-cmd="axme.addBacklogItem">+ Add item</button>
    <button class="link" data-cmd="axme.openBacklog">Open folder</button>
  \`;
  document.querySelectorAll(".bl-row").forEach((el) => {
    el.addEventListener("click", (e) => {
      // Click on the menu glyph fires a different message — don't also
      // open the file.
      const target = e.target;
      if (target && target.matches && target.matches("[data-bl-menu]")) return;
      send({ type: "openFile", path: el.getAttribute("data-path") });
    });
  });
  document.querySelectorAll("[data-bl-menu]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      send({ type: "backlogStatus", id: el.getAttribute("data-bl-menu") });
    });
  });

  // Live session block — driven by readActiveSession on the host side.
  // We deliberately do NOT show a token count: our only data source is the
  // local Cursor JSONL transcript which contains compact message envelopes,
  // not the expanded tool results that dominate Cursor's actual context
  // budget. Showing "3.8k" while Cursor's own Context panel shows 43.5k
  // confused users more than it helped. Instead we show two signals we CAN
  // measure honestly: messages (count) and duration (age).
  //
  // Warning threshold uses both. >50 messages OR >2h is a reasonable
  // proxy for "you're heading toward Cursor's ~50–60% auto-summarize
  // trigger" without lying about a token number we can't see.
  const sess = S.session;
  let sessionHtml = '<p class="muted">No active chat detected. Tools will record activity when an MCP call lands.</p>';
  if (sess && sess.hasData) {
    const startedMs = Date.parse(sess.startedAt);
    const ageMs = Number.isFinite(startedMs) ? Date.now() - startedMs : 0;
    const ageHours = ageMs / 3_600_000;
    const overWarn = sess.messages >= 50 || ageHours >= 2;
    sessionHtml = \`
      <div class="row"><span class="k">Started</span><span class="v">\${formatDuration(ageMs)} ago</span></div>
      <div class="row"><span class="k">Messages</span><span class="v">\${sess.messages}</span></div>
      \${overWarn ? \`
        <div class="warning-banner">
          Session is getting long (\${sess.messages} messages, \${formatDuration(ageMs)}).
          Cursor auto-summarizes around the ~50% context mark and quality often
          regresses after that. Ask the agent to <b>close the session</b> —
          it will extract memories / decisions / safety inline and give you a
          startup prompt for a fresh chat with zero context loss.
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
  \`;

  // Auditor dropdown is recreated on every render (lives in dynamic section),
  // so attach its change handler each time. No accumulation risk.
  const sel = document.getElementById("auditor-mode");
  if (sel) sel.addEventListener("change", (e) => send({ type: "setAuditorMode", mode: e.target.value }));
}

// Event delegation for [data-cmd] buttons — single listener on document
// catches clicks on both static footer buttons and dynamic section buttons.
// Earlier draft re-attached a handler per element on every render, causing
// "click once, command fires N times" after N renders.
document.addEventListener("click", (e) => {
  const target = e.target.closest("[data-cmd]");
  if (target) cmd(target.getAttribute("data-cmd"));
});

window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "state") {
    S = { ...S, ...e.data.state };
    render();
  }
});

render();
`;
