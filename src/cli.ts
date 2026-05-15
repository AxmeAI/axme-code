/**
 * AXME Code CLI - setup and management commands.
 *
 * Commands:
 *   axme-code setup [path]   - Full init (LLM if API key available) + .mcp.json + CLAUDE.md
 *   axme-code serve           - Start MCP server (stdio, used by .mcp.json)
 *   axme-code status [path]   - Show project status
 *   axme-code hook <name> <json> - Run hook (pre-tool-use, post-tool-use, session-end)
 */

import { resolve, join, basename } from "node:path";
import { writeFileSync, existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import yaml from "js-yaml";
import { initProjectWithLLM, initWorkspaceWithLLM } from "./tools/init.js";
import { statusTool } from "./tools/status.js";
import { detectWorkspace } from "./utils/workspace-detector.js";
import { atomicWrite, ensureDir } from "./storage/engine.js";
import { saveMemory, toMemorySlug } from "./storage/memory.js";
import { detectAuthOptions } from "./utils/auth-detect.js";
import { authConfigPath, loadAuthConfig, saveAuthConfig } from "./utils/auth-config.js";
import { formatDetectionBlock, hasAnyAuth, promptAuthChoice } from "./utils/auth-prompt.js";
import type { AuthMode, WorkspaceInfo } from "./types.js";
import { AXME_CODE_DIR, AXME_CODE_VERSION } from "./types.js";
import { EventEmitter, setMaxListeners as setMaxEventTargetListeners } from "node:events";

// Suppress Node's MaxListenersExceededWarning that occasionally fires when
// claude-agent-sdk attaches several abort-signal listeners during long LLM
// runs (e.g. 4 parallel scanners during setup). Default cap of 10 is too
// low for our usage. Three knobs to cover both EventTarget and EventEmitter
// limits across the SDK call paths:
process.setMaxListeners(50);
setMaxEventTargetListeners(50);              // EventTarget default for new instances
EventEmitter.defaultMaxListeners = 50;       // legacy EventEmitter default

const args = process.argv.slice(2);
const command = args[0];

if (command === "--version" || command === "-v") {
  console.log(AXME_CODE_VERSION);
  process.exit(0);
}

// --- CLAUDE.md templates ---

const PENDING_AUDITS_GUIDANCE = `
### Pending Audits Check (MANDATORY at session start)
When you call axme_context at session start, its output may contain a section
titled "## ⚠️ Pending audits (knowledge base may be incomplete)". This means
a previous session's LLM audit is still running in the background, and the
knowledge base you just loaded does not yet include its extracted memories,
decisions, or handoff.

When you see this section, you MUST:
1. Tell the user there is a pending audit, quote how many sessions and how
   long they have been running.
2. Offer the user two options:
   a) Wait a few minutes, then you will re-run axme_context before starting
      work so the knowledge base is fresh.
   b) Add a TODO to check back in N minutes, continue with other work in
      parallel, and re-run axme_context periodically until the pending
      audits section disappears.
3. Keep the TODO open until all pending audits are gone. Do NOT silently
   remove it — only mark it done after the pending section is empty.

This prevents you from missing freshly-extracted rules from the previous
session that might contradict what you are about to do.
`;

const STORAGE_PATH_GUIDANCE = `
### Storage paths (critical)
For any direct inspection of .axme-code/ files via Bash (ls, cat, grep, find),
ALWAYS use the absolute path from axme_context output's "# AXME Storage Root"
header. Do NOT use relative paths from your cwd. In a multi-repo workspace the
workspace root and each child repo both have their own separate .axme-code/
storage, and reading the wrong one silently gives you stale or missing data.

Every session's meta.json contains an "origin" field with the absolute path of
the directory where the MCP server was running when the session was created.
Whenever you pick up a session file directly (not via axme_context) — for
example to audit a previous run, verify an audit log, or cross-reference past
work — read meta.origin FIRST to confirm which .axme-code/ storage that session
belongs to. This is the authoritative per-session source of truth.

### Reloading axme-code after code changes
Running 'npm run build' in axme-code does NOT reload the MCP server attached to
the current VS Code window — Node caches modules in memory for the server's
lifetime. After any code change to axme-code, close and reopen the VS Code
window (Developer: Reload Window) before testing new behavior. The detached
audit worker reads fresh code from disk on each invocation, so audit-logic
iterations take effect immediately; only changes to the MCP server itself
(tool definitions, cleanupAndExit, startup) require a window reload.
`;

const SINGLE_REPO_CLAUDE_MD = `## AXME Code

### Session Start (MANDATORY)
Call axme_context tool with this project's path at the start of every session.
This loads: oracle, decisions, safety rules, memories, test plan, active plans.
Do NOT skip - without context you will miss critical project rules.
${PENDING_AUDITS_GUIDANCE}${STORAGE_PATH_GUIDANCE}
### During Work
- Error pattern or successful approach discovered -> call axme_save_memory immediately
- Architectural decision made or discovered -> call axme_save_decision immediately
- New safety constraint found -> call axme_update_safety immediately
Do not defer - save when discovered.

### Available AXME Tools
axme_context, axme_oracle, axme_decisions, axme_memories, axme_save_memory, axme_save_decision,
axme_update_safety, axme_safety, axme_status, axme_worklog, axme_workspace
`;

const WORKSPACE_CLAUDE_MD = `## AXME Code - Workspace

### Session Start (MANDATORY)
Call axme_context with this workspace root path to load workspace overview.

### Per-Repo Gate (MANDATORY)
Every repo has its own .axme-code/ storage (oracle, decisions, memory, safety) created during setup.
BEFORE reading code, making changes, or running tests in any repo:
  call axme_context with that repo's path to load repo-specific context.
Each repo has unique decisions and safety rules. Workspace context alone is NOT enough.
${PENDING_AUDITS_GUIDANCE}${STORAGE_PATH_GUIDANCE}
### During Work
- Save memories/decisions/safety rules immediately when discovered
- For cross-project findings: include scope parameter (e.g. scope: ["all"])

### Available AXME Tools
axme_context, axme_oracle, axme_decisions, axme_memories, axme_save_memory, axme_save_decision,
axme_update_safety, axme_safety, axme_status, axme_worklog, axme_workspace
`;

function generateClaudeMd(projectPath: string, isWorkspace: boolean): void {
  const claudeMdPath = join(projectPath, "CLAUDE.md");
  const section = isWorkspace ? WORKSPACE_CLAUDE_MD : SINGLE_REPO_CLAUDE_MD;

  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, "utf-8");
    if (content.includes("## AXME Code")) {
      // Replace existing section (may be minimal from check-init) with full template
      const sectionStart = content.indexOf("## AXME Code");
      const before = content.slice(0, sectionStart).trimEnd();
      writeFileSync(claudeMdPath, before ? before + "\n\n" + section : section, "utf-8");
      console.log("  CLAUDE.md: updated AXME Code section");
    } else {
      appendFileSync(claudeMdPath, "\n\n" + section, "utf-8");
      console.log("  CLAUDE.md: appended AXME Code section");
    }
  } else {
    writeFileSync(claudeMdPath, section, "utf-8");
    console.log("  CLAUDE.md: created");
  }
}

/**
 * Check if Claude auth is available.
 * Checks: ANTHROPIC_API_KEY, or a locatable `claude` CLI (which is evidence
 * the user has either an API key or a signed-in Claude subscription).
 *
 * Delegates to findClaudePath() so the PATH-separator (":" vs ";"), executable
 * suffixes (".cmd", ".exe" on Windows), and standard-install locations are all
 * handled the same way scanner agents resolve the binary — no divergence.
 */
function hasAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  // findClaudePath already checks AXME_CLAUDE_EXECUTABLE, CLAUDE_CODE_ENTRYPOINT,
  // PATH lookup, standard install locations, and nvm dirs, cross-platform.
  const { findClaudePath } = require("./utils/agent-options.js") as typeof import("./utils/agent-options.js");
  return !!findClaudePath();
}

/**
 * Print detection block + saved choice (if any).
 */
function printAuthStatus(): void {
  const options = detectAuthOptions();
  console.log(formatDetectionBlock(options));
  const saved = loadAuthConfig();
  if (saved) {
    console.log(`\nCurrent mode: ${saved.mode} (saved ${saved.chosenAt})`);
    console.log(`Config file:  ${authConfigPath()}`);
  } else {
    console.log("\nCurrent mode: not configured (using heuristic fallback)");
    console.log(`Config file:  ${authConfigPath()} (will be created on first choice)`);
  }
}

/**
 * Called from `axme-code setup` before LLM scanners launch. Persists a user
 * choice to ~/.config/axme-code/auth.yaml exactly once on first setup, so
 * subsequent runs (and all MCP server scanner/auditor subprocesses) use the
 * same mode without re-prompting. In non-TTY contexts (CI, scripts) we skip
 * the prompt and let `resolveAuthMode()` fall back to its heuristic — we do
 * NOT persist a guessed choice silently.
 */
async function ensureAuthConfiguredForSetup(): Promise<void> {
  if (loadAuthConfig()) return;
  if (!process.stdin.isTTY) return;

  const options = detectAuthOptions();
  if (!hasAnyAuth(options)) return; // hasAuth preflight will fail anyway

  console.log("\nAuthentication setup for LLM scanners");
  console.log(formatDetectionBlock(options));
  console.log("");
  const choice = await promptAuthChoice(options);
  if (!choice) {
    console.log("  Auth selection cancelled. Heuristic fallback will be used.");
    return;
  }
  if (choice === "cursor_sdk" && !options.cursorSdk?.present) {
    // User picked Cursor SDK but no key is detected yet — paste flow.
    const { promptCursorApiKey } = await import("./utils/auth-prompt.js");
    const { saveCursorApiKey } = await import("./utils/auth-config.js");
    const key = await promptCursorApiKey();
    if (!key) {
      console.log("  Cursor API key paste cancelled. Auth not saved.");
      return;
    }
    saveCursorApiKey(key);
    console.log(`  Saved Cursor API key: ~/.config/axme-code/cursor.yaml (chmod 600)`);
  }
  saveAuthConfig(choice);
  console.log(`  Saved auth mode: ${choice} (${authConfigPath()})`);
}

function generateWorkspaceYaml(workspacePath: string, ws: WorkspaceInfo): void {
  const wsYaml = yaml.dump({
    name: basename(workspacePath),
    type: ws.type,
    manifest: ws.manifestPath,
    projects: ws.projects,
  }, { lineWidth: 120 });
  ensureDir(join(workspacePath, AXME_CODE_DIR));
  atomicWrite(join(workspacePath, AXME_CODE_DIR, "workspace.yaml"), wsYaml);
  console.log("  workspace.yaml: created");
}

/**
 * Build a shell-portable hook command: `"<node>" "<self>" hook <name>
 * --workspace "<project>"`. Using the absolute node binary and the
 * axme-code entry file makes the command independent of PATH, so hooks
 * fire reliably even when the `axme-code`/`axme-code.cmd` wrapper
 * is not on the session PATH (common on Windows). Quoting every segment
 * lets Claude Code hand the string to `sh -c` or `cmd.exe /c` without
 * word-splitting on spaces.
 */
function buildHookCommand(hookName: string, projectPath: string): string {
  const nodeExec = process.execPath;
  const self = resolve(process.argv[1] ?? "axme-code");
  const q = (s: string) => `"${s}"`;
  return `${q(nodeExec)} ${q(self)} hook ${hookName} --workspace ${q(projectPath)}`;
}

function configureHooks(projectPath: string): void {
  const claudeDir = join(projectPath, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  // Read existing settings
  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }

  // Remove old hooks (without --workspace) and re-create with correct path
  for (const hookType of ["PreToolUse", "PostToolUse", "SessionEnd"]) {
    if (settings.hooks?.[hookType]) {
      settings.hooks[hookType] = settings.hooks[hookType].filter(
        (h: any) => !JSON.stringify(h).includes("axme-code"),
      );
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // PreToolUse: HARD safety enforcement - blocks dangerous commands before execution
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
  settings.hooks.PreToolUse.push({
    hooks: [{
      type: "command",
      command: buildHookCommand("pre-tool-use", projectPath),
      timeout: 5,
    }],
  });

  // PostToolUse: track filesChanged after Edit/Write
  // --workspace is hardcoded so hooks always write to workspace root, regardless of cwd
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
  settings.hooks.PostToolUse.push({
    matcher: "Edit|Write|NotebookEdit",
    hooks: [{
      type: "command",
      command: buildHookCommand("post-tool-use", projectPath),
      timeout: 10,
    }],
  });

  // SessionEnd: full session audit (memories + decisions + safety + oracle)
  if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];
  settings.hooks.SessionEnd.push({
    hooks: [{
      type: "command",
      command: buildHookCommand("session-end", projectPath),
      timeout: 120,
    }],
  });

  // Write settings
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  console.log("  .claude/settings.json: hooks configured (PostToolUse + SessionEnd)");
}

/**
 * Write bootstrap memory to AXME Code storage (.axme-code/memory/).
 */
function writeBootstrapToAxmeMemory(projectPath: string, isWorkspace: boolean, repoCount: number): void {
  const title = isWorkspace
    ? "AXME Code storage initialized for workspace"
    : "AXME Code storage initialized";
  const slug = toMemorySlug(title);
  const description = isWorkspace
    ? `axme-code setup created .axme-code/ in workspace root and all ${repoCount} git repos. Each has oracle, decisions, memory, safety.`
    : `axme-code setup created .axme-code/ with oracle, decisions, memory, safety for this project.`;

  saveMemory(projectPath, {
    slug,
    type: "pattern",
    title,
    description,
    body: isWorkspace
      ? `Two-level storage: workspace root .axme-code/ + per-repo .axme-code/ (${repoCount} repos). Both have oracle, decisions, memory, safety, sessions, plans, deploy. Call axme_context with repo path for per-repo gate.`
      : `Single project .axme-code/ with oracle, decisions, memory, safety, sessions, plans, deploy.`,
    keywords: ["axme-code", "setup", "storage", "initialized", "per-repo"],
    source: "init-scan",
    sessionId: null,
    date: new Date().toISOString().slice(0, 10),
    scope: ["all"],
  });
}

function usage(): void {
  console.log(`AXME Code - Persistent memory, decisions, and safety guardrails for Claude Code

Usage:
  axme-code setup [path] [--force] [--ide=<claude-code|cursor>]
                                                Initialize project (LLM scan + .mcp.json + CLAUDE.md
                                                for Claude Code, or .cursor/{mcp,hooks}.json + rules
                                                /axme-code.mdc for Cursor). Defaults to claude-code.
  axme-code serve                               Start MCP server (stdio transport)
  axme-code self-test                           Run local healthcheck (storage write,
                                                hook parse, MCP boot). Exits 0 on
                                                pass, 1 on any failure. Use in CI or
                                                from terminal when debugging install.
  axme-code status [path]                       Show project status
  axme-code --version | -v                      Print the installed version

  axme-code config get <key>                    Read a value from .axme-code/config.yaml
                                                (keys: context.mode, model, auditor_model, review_enabled)
  axme-code config set context.mode <full|search>
                                                Switch context-loading mode. 'search' installs the
                                                semantic-search runtime (~100MB, one-time) and
                                                builds an embeddings index of every memory + decision.
                                                Rolls back to 'full' on install or reindex failure.
  axme-code reindex [path]                      Force a full re-embed of all memories + decisions
                                                into .axme-code/_index/embeddings.json (search mode only)

  axme-code auth                                Re-detect and choose auth mode
                                                (subscription / api_key / cursor_sdk)
  axme-code auth status                         Show current auth mode + detected options
  axme-code auth use <subscription|api_key|cursor_sdk>
                                                Set auth mode non-interactively
  axme-code cleanup legacy-artifacts [--dry-run]   Remove pre-PR#7 sessions/logs
  axme-code cleanup decisions-normalize [--dry-run]   Add status:active to decisions
  axme-code audit-kb [path] [--all-repos]       KB audit: dedup, conflicts, compaction
  axme-code stats [path]                        Worklog statistics (sessions, costs, safety blocks)
  axme-code help                                Show this help

After setup, run 'claude' as usual. AXME tools are available automatically.`);
}

async function main() {
  // Send anonymous startup telemetry only for user-facing CLI commands.
  // Hook and audit-session subcommands run as short-lived subprocesses
  // (Claude Code hooks fire many times per session, audit-session is a
  // detached background worker), so firing telemetry per invocation would
  // spam the endpoint and skew startup counts. The `serve` command sends
  // its own startup event from server.ts after MCP server is up.
  // We AWAIT this so events flush before heavy work begins — under event
  // loop pressure (LLM scanners), fire-and-forget setImmediate may stall.
  const startupCommands = new Set(["setup", "status", "stats", "audit-kb", "cleanup", "help"]);
  if (command && startupCommands.has(command)) {
    const { sendStartupEvents } = await import("./telemetry.js");
    await sendStartupEvents();
  }

  switch (command) {
    case "setup": {
      const setupStartMs = Date.now();
      const forceSetup = args.includes("--force");
      const pluginMode = args.includes("--plugin") || !!process.env.CLAUDE_PLUGIN_ROOT;
      const { parseIdeFlag } = await import("./utils/ide-detect.js");
      const ide = parseIdeFlag(args) ?? "claude-code";
      if (ide === "cursor" && pluginMode) {
        console.error("Error: --ide=cursor is not supported with --plugin in this release.");
        console.error("Run setup without --plugin (Cursor plugin packaging is a Phase 2 follow-up).");
        process.exit(1);
      }
      // Strip --force, --plugin, --ide and its value from positional args.
      const setupArgs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--force" || a === "--plugin") continue;
        if (a === "--ide") { i++; continue; } // also skip the value
        if (a.startsWith("--ide=")) continue;
        setupArgs.push(a);
      }
      const projectPath = resolve(setupArgs[1] || ".");
      const hasGitDir = existsSync(join(projectPath, ".git"));
      const ws = detectWorkspace(projectPath);
      const isWorkspace = hasGitDir ? false : ws.type !== "single";
      const childRepos = isWorkspace
        ? ws.projects.filter(p => existsSync(join(projectPath, p.path, ".git"))).length
        : 0;
      // Telemetry-relevant fields, populated as setup progresses
      let setupOutcome: "success" | "fallback" | "failed" = "failed";
      let setupMethod: "llm" | "deterministic" = "deterministic";
      let setupPhaseFailed: string | null = null;
      let setupPresetsApplied = 0;
      let setupScannersRun = 0;
      let setupScannersFailed = 0;
      // Use the blocking variant so the event lands BEFORE process.exit() runs.
      // The fire-and-forget sendTelemetry uses setImmediate, which is killed
      // by process.exit() before the network request is even started.
      const sendSetupTelemetry = async () => {
        try {
          const { sendTelemetryBlocking } = await import("./telemetry.js");
          await sendTelemetryBlocking("setup_complete", {
            outcome: setupOutcome,
            duration_ms: Date.now() - setupStartMs,
            method: setupMethod,
            scanners_run: setupScannersRun,
            scanners_failed: setupScannersFailed,
            phase_failed: setupPhaseFailed,
            presets_applied: setupPresetsApplied,
            is_workspace: isWorkspace,
            child_repos: childRepos,
          });
        } catch { /* swallow */ }
      };

      if (isWorkspace) {
        console.log(`Initializing AXME Code workspace in ${projectPath} (${ws.type}, ${ws.projects.length} projects)...`);
      } else {
        console.log(`Initializing AXME Code in ${projectPath}...`);
      }

      // Pre-flight auth check
      if (!hasAuth()) {
        console.error(`\nError: No Claude authentication found.\n`);
        console.error(`AXME Code requires Claude subscription or API access for LLM scanning.`);
        console.error(`To authenticate, run one of:`);
        console.error(`  claude login              (Claude subscription)`);
        console.error(`  export ANTHROPIC_API_KEY=sk-ant-...  (API key)\n`);
        setupOutcome = "failed";
        setupPhaseFailed = "auth_check";
        await sendSetupTelemetry();
        process.exit(1);
      }

      // Auth mode selection — prompt once on first interactive setup, persist
      // to ~/.config/axme-code/auth.yaml. Later runs and scanner subprocesses
      // read the saved mode via resolveAuthMode() in buildAgentEnv().
      await ensureAuthConfiguredForSetup();

      // Init with LLM scanners (parallel)
      try {
        if (isWorkspace) {
          const { workspaceResult, projectResults } = await initWorkspaceWithLLM(projectPath, { onProgress: console.log });
          const totalCost = workspaceResult.cost.costUsd + projectResults.reduce((s, r) => s + r.cost.costUsd, 0);
          console.log(`  Workspace: ${workspaceResult.decisions.count} decisions, ${workspaceResult.memories.count} memories`);
          for (const r of projectResults) {
            const name = basename(r.projectPath);
            console.log(`  ${name}: ${r.decisions.count} decisions (${r.decisions.fromScan} LLM + ${r.decisions.fromPresets} presets)`);
          }
          if (totalCost > 0) console.log(`  Total cost: $${totalCost.toFixed(2)}`);
          for (const e of [...workspaceResult.errors, ...projectResults.flatMap(r => r.errors)]) {
            console.log(`  Warning: ${e}`);
          }
          generateWorkspaceYaml(projectPath, ws);
          // Track telemetry: any LLM scan in any repo means LLM method
          const anyLlm = projectResults.some(r => r.oracle.llm) || workspaceResult.decisions.fromScan > 0;
          setupMethod = anyLlm ? "llm" : "deterministic";
          setupPresetsApplied = projectResults.reduce((s, r) => s + (r.decisions.fromPresets || 0), 0);
          // Sum scanner counts across workspace + all projects
          setupScannersRun = workspaceResult.scannersRun + projectResults.reduce((s, r) => s + r.scannersRun, 0);
          setupScannersFailed = workspaceResult.scannersFailed + projectResults.reduce((s, r) => s + r.scannersFailed, 0);
        } else {
          const result = await initProjectWithLLM(projectPath, { onProgress: console.log, force: forceSetup });
          if (!result.created && result.durationMs === 0) {
            console.log(`  Already initialized (skipped LLM scan). Use --force to re-scan.`);
            console.log(`  Decisions: ${result.decisions.count}, Memories: ${result.memories.count}`);
          } else {
            console.log(`  Oracle: ${result.oracle.files} files (${result.oracle.llm ? "LLM scan" : "deterministic fallback"})`);
            console.log(`  Decisions: ${result.decisions.count} (${result.decisions.fromScan} LLM + ${result.decisions.fromPresets} presets)`);
            console.log(`  Memories: ${result.memories.count} (${result.memories.fromPresets} from presets)`);
            console.log(`  Safety: ${result.safety.llm ? "LLM scan" : "defaults + presets"}`);
            if (result.cost.costUsd > 0) console.log(`  Cost: $${result.cost.costUsd.toFixed(2)}, ${(result.durationMs / 1000).toFixed(1)}s`);
            for (const e of result.errors) console.log(`  Warning: ${e}`);
          }
          // Track telemetry: oracle.llm tells us whether LLM path was used
          setupMethod = result.oracle.llm ? "llm" : "deterministic";
          setupPresetsApplied = (result.decisions.fromPresets || 0);
          setupScannersRun = result.scannersRun;
          setupScannersFailed = result.scannersFailed;
        }
      } catch (err) {
        setupOutcome = "failed";
        setupPhaseFailed = "init_scan";
        const { classifyError, reportError } = await import("./telemetry.js");
        try { reportError("setup", classifyError(err), true); } catch { /* swallow */ }
        await sendSetupTelemetry();
        throw err;
      }

      // Detect plugin context — skip .mcp.json and hooks if running from plugin
      // (plugin provides its own .mcp.json and hooks/hooks.json)
      const isPlugin = pluginMode;

      if (!isPlugin) {
        // Create or update .mcp.json (workspace root + each child repo).
        // Cursor reads BOTH .mcp.json AND .cursor/mcp.json — we always write
        // the root file regardless of --ide so a repo configured for Cursor
        // can also be opened in Claude Code without re-running setup.
        const mcpEntry = { command: "axme-code", args: ["serve"] };
        const mcpPaths = [projectPath];
        if (isWorkspace) {
          for (const p of ws.projects) {
            mcpPaths.push(join(projectPath, p.path));
          }
        }
        for (const dir of mcpPaths) {
          const mcpPath = join(dir, ".mcp.json");
          let mcpConfig: Record<string, any> = {};
          if (existsSync(mcpPath)) {
            try { mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8")); } catch { mcpConfig = {}; }
          }
          if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
          mcpConfig.mcpServers.axme = mcpEntry;
          writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");
        }
        console.log(`  .mcp.json: updated (${mcpPaths.length} locations)`);
      } else {
        console.log(`  .mcp.json: skipped (plugin provides MCP server)`);
      }

      if (ide === "cursor") {
        // Cursor branch: write .cursor/{mcp,hooks}.json + rules/axme-code.mdc.
        // Skip .claude/CLAUDE.md (D-080: agent must never write to it) and
        // .claude/settings.json (Cursor doesn't read it).
        const { writeCursorMcpJson, writeCursorHooksJson, writeCursorRulesMdc } =
          await import("./setup/cursor-writers.js");
        const cursorPaths = [projectPath];
        if (isWorkspace) {
          for (const p of ws.projects) cursorPaths.push(join(projectPath, p.path));
        }
        for (const dir of cursorPaths) writeCursorMcpJson(dir);
        console.log(`  .cursor/mcp.json: updated (${cursorPaths.length} locations)`);
        writeCursorHooksJson(projectPath, buildHookCommand);
        console.log("  .cursor/hooks.json: hooks configured (preToolUse + postToolUse + sessionEnd)");
        writeCursorRulesMdc(projectPath, isWorkspace);
        console.log("  .cursor/rules/axme-code.mdc: created");
      } else {
        // Claude Code branch (unchanged): CLAUDE.md + .claude/settings.json
        generateClaudeMd(projectPath, isWorkspace);
        if (!isPlugin) {
          configureHooks(projectPath);
        } else {
          console.log(`  Hooks: skipped (plugin provides hooks)`);
        }
      }

      // Add .axme-code/ to .gitignore
      const gitignorePath = join(projectPath, ".gitignore");
      if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, "utf-8");
        if (!content.includes(".axme-code")) {
          writeFileSync(gitignorePath, content.trimEnd() + "\n.axme-code/\n", "utf-8");
          console.log("  .gitignore: added .axme-code/");
        }
      } else {
        writeFileSync(gitignorePath, ".axme-code/\n", "utf-8");
        console.log("  .gitignore: created with .axme-code/");
      }

      // Write bootstrap memory to AXME Code storage
      const repoCount = isWorkspace
        ? ws.projects.filter(p => existsSync(join(projectPath, p.path, ".git"))).length
        : 0;
      writeBootstrapToAxmeMemory(projectPath, isWorkspace, repoCount);

      // Setup completed. setupMethod was set above by the init scan.
      // outcome=success when LLM ran end-to-end, fallback when deterministic was used.
      setupOutcome = setupMethod === "llm" ? "success" : "fallback";
      await sendSetupTelemetry();

      // If semantic search was already enabled before setup (e.g. the user
      // turned it on in a different project where the runtime is already
      // installed, or pre-enabled in expectation of running setup), the
      // LLM/deterministic scanners just wrote a bunch of decisions and
      // memories directly to disk via the storage layer — bypassing the
      // MCP save-tool's auto-embed step. The result is a populated KB but
      // an empty embeddings index, and axme_search_kb returns nothing.
      // Auto-reindex here so the user doesn't have to remember to run
      // `axme-code reindex` after every setup.
      try {
        const { readConfig } = await import("./storage/config.js");
        const cfg = readConfig(projectPath);
        if (cfg.contextMode === "search") {
          const { isRuntimeInstalled } = await import("./storage/embeddings.js");
          if (isRuntimeInstalled()) {
            const { reindexAll } = await import("./tools/search-install.js");
            const r = await reindexAll(projectPath);
            if (r.ok) console.log(`Indexed ${r.indexed} entries for semantic search.`);
            else console.error(`Search reindex skipped: ${r.error}`);
          } else {
            console.error("Search mode is on but the embeddings runtime is missing — run `axme-code reindex` manually after installing.");
          }
        }
      } catch (err) {
        console.error(`Search reindex post-setup failed (non-fatal): ${(err as Error).message}`);
      }

      // IDE-aware final message. The CLI is invoked both standalone
      // (Claude Code users — `axme-code setup` from terminal) and via
      // the Cursor extension's setup-controller (`--ide=cursor`).
      // Tell each user what their next step actually is.
      if (ide === "cursor") {
        console.log("\nDone! Open a new chat in Cursor — AXME tools are now available.");
      } else {
        console.log("\nDone! Run 'claude' to start using AXME tools.");
      }
      break;
    }

    case "serve": {
      await import("./server.js");
      break;
    }

    case "self-test": {
      // v0.0.2: local healthcheck for storage / hook adapters / MCP boot.
      // Used by `AXME: Show Status` webview indirectly + by power users
      // running the binary from terminal when something looks wrong.
      const { runSelfTest } = await import("./self-test.js");
      const code = await runSelfTest();
      process.exit(code);
    }

    case "status": {
      const projectPath = resolve(args[1] || ".");
      console.log(statusTool(projectPath));
      break;
    }

    case "hook": {
      const hookName = args[1];
      // Parse --workspace flag from CLI args
      const wsIdx = args.indexOf("--workspace");
      const workspacePath = wsIdx >= 0 && args[wsIdx + 1] ? args[wsIdx + 1] : undefined;
      // Parse --ide flag from CLI args (defaults to claude-code).
      const { parseIdeFlag } = await import("./utils/ide-detect.js");
      const ide = parseIdeFlag(args) ?? "claude-code";

      if (hookName === "pre-tool-use") {
        const { runPreToolUseHook } = await import("./hooks/pre-tool-use.js");
        await runPreToolUseHook(workspacePath, ide);
      } else if (hookName === "post-tool-use") {
        const { runPostToolUseHook } = await import("./hooks/post-tool-use.js");
        await runPostToolUseHook(workspacePath, ide);
      } else if (hookName === "session-end") {
        const { runSessionEndHook } = await import("./hooks/session-end.js");
        await runSessionEndHook(workspacePath, ide);
      }
      break;
    }

    case "check-init": {
      // Plugin SessionStart hook — lazy-install the SDK if we're running from
      // a plugin root that hasn't had one yet, then ensure CLAUDE.md exists
      // and output the instruction. Moving the lazy install inline here (vs.
      // an inline shell test in hooks.json) makes SessionStart cross-platform
      // — the previous `test -d ... || (cd ... && npm install) ; node ...`
      // uses POSIX-only syntax that cmd.exe can't execute.
      if (process.env.CLAUDE_PLUGIN_ROOT) {
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
        const sdkDir = join(pluginRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
        if (!existsSync(sdkDir)) {
          try {
            const { execSync } = await import("node:child_process");
            // execSync always spawns through a shell (sh on POSIX, cmd.exe on
            // Windows), so `npm` resolves to `npm.cmd` on Windows without any
            // extra flag.
            execSync("npm install --omit=dev --ignore-scripts", {
              cwd: pluginRoot,
              stdio: "ignore",
              timeout: 25_000,
            });
          } catch {
            // Silent — fall through. The plugin still works for deterministic
            // paths (safety hooks, context lookup) even without the SDK;
            // only LLM-backed scans need it and they'll fail loudly later.
          }
        }
      }

      const checkPath = resolve(args[1] || ".");
      const claudeMdPath = join(checkPath, "CLAUDE.md");
      const axmeSection = `## AXME Code

### Session Start (MANDATORY)
Call axme_context at the start of every session.
If it returns "not initialized", run \`axme-code setup --plugin\` via Bash tool immediately.
Do NOT skip — without context you will miss critical project rules.
`;
      // Ensure CLAUDE.md has AXME section
      if (existsSync(claudeMdPath)) {
        const content = readFileSync(claudeMdPath, "utf-8");
        if (!content.includes("## AXME Code")) {
          writeFileSync(claudeMdPath, content.trimEnd() + "\n\n" + axmeSection, "utf-8");
        }
      } else {
        writeFileSync(claudeMdPath, axmeSection, "utf-8");
      }

      const { configExists } = await import("./storage/config.js");
      if (configExists(checkPath)) {
        console.log(`[AXME Code] Knowledge base ready. Call axme_context now.`);
      } else {
        console.log(`[AXME Code] Project not initialized. Run: axme-code setup --plugin`);
      }
      break;
    }

    case "audit-session": {
      // Standalone entry point for the detached audit worker. Takes the
      // workspace path and an AXME session id, runs runSessionCleanup on
      // the pair, and exits. This is what src/audit-spawner.ts spawns in
      // a detached child — it is also directly invokable from the shell
      // for manual force re-audit of a specific session.
      const wsIdx = args.indexOf("--workspace");
      const sidIdx = args.indexOf("--session");
      const workspacePath = wsIdx >= 0 && args[wsIdx + 1] ? resolve(args[wsIdx + 1]) : undefined;
      const sessionId = sidIdx >= 0 && args[sidIdx + 1] ? args[sidIdx + 1] : undefined;
      if (!workspacePath || !sessionId) {
        console.error("audit-session requires --workspace <path> --session <axme-uuid>");
        process.exit(2);
      }
      process.stderr.write(
        `axme-code audit-session: workspace=${workspacePath} session=${sessionId} pid=${process.pid}\n`,
      );
      // Register signal handlers so SIGTERM/SIGINT (OOM killer, manual kill)
      // updates audit status before exit. SIGKILL is uncatchable - handled
      // by 15-minute stale timeout in runSessionCleanup.
      const signalCleanup = (signal: string) => {
        process.stderr.write(`axme-code audit-session: received ${signal}, cleaning up\n`);
        try {
          const { loadSession, writeSession } = require("./storage/sessions.js");
          const s = loadSession(workspacePath, sessionId);
          if (s && s.auditStatus === "pending") {
            s.auditStatus = "failed";
            s.lastAuditError = `killed by ${signal}`;
            s.auditFinishedAt = new Date().toISOString();
            writeSession(workspacePath, s);
          }
        } catch {}
        process.exit(1);
      };
      process.on("SIGTERM", () => signalCleanup("SIGTERM"));
      process.on("SIGINT", () => signalCleanup("SIGINT"));
      try {
        const { runSessionCleanup } = await import("./session-cleanup.js");
        const result = await runSessionCleanup(workspacePath, sessionId);
        process.stderr.write(`axme-code audit-session: ${JSON.stringify(result)}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        process.stderr.write(`axme-code audit-session FAILED: ${stack ?? msg}\n`);
        process.exit(1);
      }
      process.exit(0);
    }

    case "cleanup": {
      const subCommand = args[1];
      const dryRun = args.includes("--dry-run");
      // Path is the first non-flag arg after subCommand, or "."
      const pathArg = args.slice(2).find(a => !a.startsWith("--"));
      const projectPath = resolve(pathArg || ".");

      if (subCommand === "legacy-artifacts") {
        const { cleanupLegacyArtifacts } = await import("./tools/cleanup.js");
        console.log(`Cleaning legacy artifacts in ${projectPath}${dryRun ? " (dry run)" : ""}...`);
        const result = cleanupLegacyArtifacts(projectPath, { dryRun, onProgress: console.log });
        console.log(`\nSummary: ${result.sessionsDeleted} sessions, ${result.auditLogsDeleted} audit logs, ${result.legacyDirsRemoved.length} legacy dirs`);
        if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
      } else if (subCommand === "decisions-normalize") {
        const { normalizeDecisions } = await import("./tools/cleanup.js");
        console.log(`Normalizing decisions in ${projectPath}${dryRun ? " (dry run)" : ""}...`);
        const result = normalizeDecisions(projectPath, { dryRun, onProgress: console.log });
        console.log(`\nSummary: ${result.filesUpdated} updated, ${result.filesSkipped} skipped, ${result.locations} locations`);
      } else {
        console.error(`Unknown cleanup subcommand: ${subCommand}`);
        console.error("Available: legacy-artifacts, decisions-normalize");
        process.exit(1);
      }
      break;
    }

    case "audit-kb": {
      // Parse path argument: first non-flag arg after "audit-kb"
      const kbPathArg = args.slice(1).find(a => !a.startsWith("--"));
      let targetPath: string;
      if (kbPathArg) {
        // Explicit path: use as-is (audit that specific repo/dir)
        targetPath = resolve(kbPathArg);
      } else {
        // No path: auto-detect workspace root from cwd
        targetPath = resolve(".");
        const ws = detectWorkspace(targetPath);
        if (ws.type === "single") {
          const parentWs = detectWorkspace(resolve(".."));
          if (parentWs.type !== "single") targetPath = parentWs.root;
        } else {
          targetPath = ws.root;
        }
      }
      const allRepos = args.includes("--all-repos");

      console.log(`KB Audit: ${targetPath}${allRepos ? " (all repos)" : ""}`);
      console.log(`Agent will read decisions + memories, check code, and update storage directly.\n`);

      const { runKbAudit } = await import("./agents/kb-auditor.js");
      const result = await runKbAudit({ targetPath, allRepos });

      console.log(`\nDone: $${result.costUsd.toFixed(2)}, ${(result.durationMs / 1000).toFixed(0)}s`);

      const { resetKbAuditCounter } = await import("./storage/kb-audit.js");
      resetKbAuditCounter(targetPath);
      break;
    }

    case "stats": {
      const statsPath = resolve(args[1] || ".");
      const { worklogStats } = await import("./storage/worklog.js");
      const s = worklogStats(statsPath);
      console.log(`AXME Code Stats for ${statsPath}\n`);
      console.log(`Sessions:      ${s.totalSessions}`);
      console.log(`Audits:        ${s.totalAudits}`);
      console.log(`Total cost:    $${s.totalCostUsd.toFixed(2)}`);
      console.log(`Safety blocks: ${s.safetyBlocks.length}`);
      if (s.safetyBlocks.length > 0) {
        console.log(`\nRecent safety blocks:`);
        for (const b of s.safetyBlocks.slice(0, 10)) {
          const ts = b.timestamp.replace("T", " ").slice(0, 19);
          console.log(`  [${ts}] ${b.tool}: ${b.target.slice(0, 60)} - ${b.reason}`);
        }
      }
      if (s.recentErrors.length > 0) {
        console.log(`\nRecent errors:`);
        for (const e of s.recentErrors.slice(0, 5)) {
          const ts = e.timestamp.replace("T", " ").slice(0, 19);
          console.log(`  [${ts}] ${e.error.slice(0, 100)}`);
        }
      }
      break;
    }

    case "auth": {
      const sub = args[1];
      if (sub === "status" || sub === "show") {
        printAuthStatus();
        break;
      }
      if (sub === "use" || sub === "set") {
        const mode = args[2];
        if (mode !== "subscription" && mode !== "api_key" && mode !== "cursor_sdk") {
          console.error("Usage: axme-code auth use <subscription|api_key|cursor_sdk>");
          process.exit(1);
        }
        if (mode === "cursor_sdk") {
          // Non-interactive set still requires a key — read from
          // CURSOR_API_KEY env or refuse politely.
          const { loadCursorApiKey, saveCursorApiKey } = await import("./utils/auth-config.js");
          if (!loadCursorApiKey() && !process.env.CURSOR_API_KEY) {
            console.error(
              "cursor_sdk mode requires a key. Set CURSOR_API_KEY in env, or run\n" +
                "  axme-code auth          (interactive — paste key when prompted)",
            );
            process.exit(1);
          }
          if (process.env.CURSOR_API_KEY && !loadCursorApiKey()) {
            saveCursorApiKey(process.env.CURSOR_API_KEY);
            console.log("  Saved Cursor API key from env to ~/.config/axme-code/cursor.yaml (chmod 600)");
          }
        }
        saveAuthConfig(mode as AuthMode);
        console.log(`Saved auth mode: ${mode} (${authConfigPath()})`);
        break;
      }
      if (sub === undefined || sub === "choose") {
        const options = detectAuthOptions();
        console.log("Authentication setup for LLM scanners");
        console.log(formatDetectionBlock(options));
        const saved = loadAuthConfig();
        if (saved) console.log(`\nCurrent mode: ${saved.mode} (saved ${saved.chosenAt})`);
        console.log("");
        if (!hasAnyAuth(options)) {
          console.error("No authentication detected. Set ANTHROPIC_API_KEY or run `claude /login`, then re-run `axme-code auth`.");
          process.exit(1);
        }
        if (!process.stdin.isTTY) {
          console.error("`axme-code auth` requires an interactive terminal. Use `axme-code auth use <subscription|api_key|cursor_sdk>` non-interactively.");
          process.exit(1);
        }
        const choice = await promptAuthChoice(options);
        if (!choice) {
          console.log("Cancelled. No change.");
          break;
        }
        if (choice === "cursor_sdk" && !options.cursorSdk?.present) {
          const { promptCursorApiKey } = await import("./utils/auth-prompt.js");
          const { saveCursorApiKey } = await import("./utils/auth-config.js");
          const key = await promptCursorApiKey();
          if (!key) {
            console.log("Cursor API key paste cancelled. No change.");
            break;
          }
          saveCursorApiKey(key);
          console.log("  Saved Cursor API key: ~/.config/axme-code/cursor.yaml (chmod 600)");
        }
        saveAuthConfig(choice);
        console.log(`Saved auth mode: ${choice} (${authConfigPath()})`);
        break;
      }
      console.error(`Unknown 'auth' subcommand: ${sub}`);
      console.error("Available: (none)|choose, status|show, use|set <subscription|api_key|cursor_sdk>");
      process.exit(1);
    }

    case "config": {
      // axme-code config get <key>
      // axme-code config set <key> <value>
      // Currently supported keys: context.mode (full|search). The set path
      // for context.mode = search atomically installs the transformers
      // runtime + builds the initial embeddings index, and rolls the
      // config back to "full" if either step fails (D-136 / B-005 design).
      const sub = args[1];
      const key = args[2];
      const value = args[3];
      const projectPath = resolve(".");
      const { readConfig: rc, writeConfig: wc } = await import("./storage/config.js");

      if (sub === "get") {
        if (!key) {
          console.error("usage: axme-code config get <key>  (e.g. context.mode)");
          process.exit(1);
        }
        const cfg = rc(projectPath);
        if (key === "context.mode") console.log(cfg.contextMode);
        else if (key === "model") console.log(cfg.model);
        else if (key === "auditor_model") console.log(cfg.auditorModel);
        else if (key === "review_enabled") console.log(String(cfg.reviewEnabled));
        else { console.error(`Unknown config key: ${key}`); process.exit(1); }
        break;
      }

      if (sub === "set") {
        if (!key || value === undefined) {
          console.error("usage: axme-code config set <key> <value>");
          process.exit(1);
        }
        if (key !== "context.mode") {
          console.error(`Set is currently supported only for context.mode. Got: ${key}`);
          process.exit(1);
        }
        if (value !== "full" && value !== "search") {
          console.error(`context.mode must be 'full' or 'search'. Got: ${value}`);
          process.exit(1);
        }
        const cfg = rc(projectPath);
        const prevMode = cfg.contextMode;

        if (value === "full") {
          wc(projectPath, { ...cfg, contextMode: "full" });
          console.log("Saved: context.mode = full");
          break;
        }

        // value === "search" — install runtime if missing, then reindex.
        const { runConfigSetSearch } = await import("./tools/search-install.js");
        const result = await runConfigSetSearch(projectPath);
        if (result.ok) {
          wc(projectPath, { ...cfg, contextMode: "search" });
          console.log(`Saved: context.mode = search (indexed ${result.indexed} entries)`);
        } else {
          // Rollback config to whatever it was before — we never changed it
          // in the failure path, but be explicit so future edits don't drop
          // this guarantee.
          wc(projectPath, { ...cfg, contextMode: prevMode });
          console.error(`\nFailed to enable search mode: ${result.error}`);
          console.error(`Config left at context.mode = ${prevMode}.`);
          process.exit(1);
        }
        break;
      }

      console.error("Unknown 'config' subcommand. Available: get <key>, set <key> <value>");
      process.exit(1);
    }

    case "reindex": {
      // Rebuild the embeddings index from every memory + decision on disk.
      // No-op if context.mode = full and runtime is missing — caller should
      // run `axme-code config set context.mode search` first.
      const projectPath = resolve(args[1] || ".");
      const { reindexAll } = await import("./tools/search-install.js");
      const result = await reindexAll(projectPath);
      if (result.ok) console.log(`Reindexed ${result.indexed} entries.`);
      else { console.error(`Reindex failed: ${result.error}`); process.exit(1); }
      break;
    }

    case "backlog": {
      // Lightweight CLI for the v0.0.3 extension sidebar's [+ Add] button.
      // The MCP `axme_backlog_add` tool already handles agent-driven
      // writes; this subcommand is the user-driven equivalent so the
      // sidebar doesn't need to duplicate the ID-generation + atomic-
      // write logic, and isn't dependent on an agent being in the loop.
      const sub = args[1];
      const projectPath = resolve(process.cwd());
      const { addBacklogItem, listBacklogItems } = await import("./storage/backlog.js");
      if (sub === "list") {
        // --json prints machine-readable for the extension; default is
        // human-readable so power users can `axme-code backlog list` in
        // a terminal too.
        const items = listBacklogItems(projectPath);
        if (args.includes("--json")) {
          console.log(JSON.stringify(items));
        } else if (items.length === 0) {
          console.log("No backlog items.");
        } else {
          for (const i of items) console.log(`${i.id} [${i.status}/${i.priority}] ${i.title}`);
        }
        break;
      }
      if (sub === "add") {
        const flag = (name: string): string | undefined => {
          const idx = args.indexOf(`--${name}`);
          return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
        };
        const title = flag("title");
        if (!title) { console.error("backlog add: --title is required"); process.exit(1); }
        const priority = (flag("priority") || "medium") as "high" | "medium" | "low";
        const description = flag("description") || "";
        const item = addBacklogItem(projectPath, { title, description, priority });
        console.log(item.id);
        break;
      }
      if (sub === "update") {
        const flag = (name: string): string | undefined => {
          const idx = args.indexOf(`--${name}`);
          return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
        };
        const id = flag("id");
        if (!id) { console.error("backlog update: --id is required"); process.exit(1); }
        const status = flag("status") as "open" | "in-progress" | "done" | "blocked" | undefined;
        const priority = flag("priority") as "high" | "medium" | "low" | undefined;
        const notes = flag("notes");
        const { updateBacklogItem } = await import("./storage/backlog.js");
        const updated = updateBacklogItem(projectPath, id, { status, priority, notes });
        if (!updated) { console.error(`backlog update: ${id} not found`); process.exit(1); }
        console.log(`${updated.id} → status=${updated.status}, priority=${updated.priority}`);
        break;
      }
      console.error("Usage: axme-code backlog <list|add|update> [--title ... --priority ... --description ... --id ... --status ...]");
      process.exit(1);
      break;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined: {
      usage();
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
