/**
 * AXME Code CLI - setup and management commands.
 *
 * Commands:
 *   axme-code setup [path]   - Full init (LLM if API key available) + .mcp.json + CLAUDE.md
 *   axme-code serve           - Start MCP server (stdio, used by .mcp.json)
 *   axme-code status [path]   - Show project status
 *   axme-code hook <name> <json> - Run hook (post-tool-use, session-end)
 */

import { resolve, join } from "node:path";
import { writeFileSync, existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import yaml from "js-yaml";
import { initProjectWithLLM, initWorkspaceWithLLM } from "./tools/init.js";
import { statusTool } from "./tools/status.js";
import { detectWorkspace } from "./utils/workspace-detector.js";
import { atomicWrite, ensureDir } from "./storage/engine.js";
import { saveMemory, toMemorySlug } from "./storage/memory.js";
import type { WorkspaceInfo } from "./types.js";
import { AXME_CODE_DIR } from "./types.js";

const args = process.argv.slice(2);
const command = args[0];

// --- CLAUDE.md templates ---

const SINGLE_REPO_CLAUDE_MD = `## AXME Code

### Session Start (MANDATORY)
Call axme_context tool with this project's path at the start of every session.
This loads: oracle, decisions, safety rules, memories, test plan, active plans.
Do NOT skip - without context you will miss critical project rules.

### During Work
- Error pattern or successful approach discovered -> call axme_save_memory immediately
- Architectural decision made or discovered -> call axme_save_decision immediately
- New safety constraint found -> call axme_update_safety immediately
Do not defer - save when discovered.

### Available AXME Tools
axme_context, axme_save_memory, axme_search_memory, axme_save_decision,
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

### During Work
- Save memories/decisions/safety rules immediately when discovered
- For cross-project findings: include scope parameter (e.g. scope: ["all"])

### Available AXME Tools
axme_context, axme_save_memory, axme_search_memory, axme_save_decision,
axme_update_safety, axme_safety, axme_status, axme_worklog, axme_workspace
`;

function generateClaudeMd(projectPath: string, isWorkspace: boolean): void {
  const claudeMdPath = join(projectPath, "CLAUDE.md");
  const section = isWorkspace ? WORKSPACE_CLAUDE_MD : SINGLE_REPO_CLAUDE_MD;

  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, "utf-8");
    if (content.includes("## AXME Code")) {
      return; // already has our section
    }
    appendFileSync(claudeMdPath, "\n\n" + section, "utf-8");
    console.log("  CLAUDE.md: appended AXME Code section");
  } else {
    writeFileSync(claudeMdPath, section, "utf-8");
    console.log("  CLAUDE.md: created");
  }
}

/**
 * Check if Claude auth is available.
 * Checks: ANTHROPIC_API_KEY, or claude binary exists on disk.
 */
function hasAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;

  // Check common claude binary locations directly (no shell needed)
  const { env } = process;
  const pathDirs = (env.PATH || "").split(":");
  for (const dir of pathDirs) {
    if (existsSync(join(dir, "claude"))) return true;
  }

  return false;
}

function generateWorkspaceYaml(workspacePath: string, ws: WorkspaceInfo): void {
  const wsYaml = yaml.dump({
    name: workspacePath.split("/").pop(),
    type: ws.type,
    manifest: ws.manifestPath,
    projects: ws.projects,
  }, { lineWidth: 120 });
  ensureDir(join(workspacePath, AXME_CODE_DIR));
  atomicWrite(join(workspacePath, AXME_CODE_DIR, "workspace.yaml"), wsYaml);
  console.log("  workspace.yaml: created");
}

function configureHooks(projectPath: string): void {
  const claudeDir = join(projectPath, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  // Read existing settings
  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }

  // Check if hooks already configured
  if (settings.hooks?.PostToolUse?.some?.((h: any) => JSON.stringify(h).includes("axme-code"))) {
    return; // already configured
  }

  if (!settings.hooks) settings.hooks = {};

  // PostToolUse: track filesChanged after Edit/Write
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
  settings.hooks.PostToolUse.push({
    matcher: "Edit|Write|NotebookEdit",
    hooks: [{
      type: "command",
      command: "axme-code hook post-tool-use",
      timeout: 10,
    }],
  });

  // SessionEnd: full session audit (memories + decisions + safety + oracle)
  if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];
  settings.hooks.SessionEnd.push({
    hooks: [{
      type: "command",
      command: "axme-code hook session-end",
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
  console.log(`AXME Code - MCP server for Claude Code CLI

Usage:
  axme-code setup [path]    Initialize project (LLM scan + .mcp.json + CLAUDE.md)
  axme-code serve           Start MCP server (stdio transport)
  axme-code status [path]   Show project status
  axme-code help            Show this help

After setup, run 'claude' as usual. AXME tools are available automatically.`);
}

async function main() {
  switch (command) {
    case "setup": {
      const projectPath = resolve(args[1] || ".");
      const ws = detectWorkspace(projectPath);
      const isWorkspace = ws.type !== "single";

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
        process.exit(1);
      }

      // Init with LLM scanners (parallel)
      if (isWorkspace) {
        const { workspaceResult, projectResults } = await initWorkspaceWithLLM(projectPath, { onProgress: console.log });
        const totalCost = workspaceResult.cost.costUsd + projectResults.reduce((s, r) => s + r.cost.costUsd, 0);
        console.log(`  Workspace: ${workspaceResult.decisions.count} decisions, ${workspaceResult.memories.count} memories`);
        for (const r of projectResults) {
          const name = r.projectPath.split("/").pop();
          console.log(`  ${name}: ${r.decisions.count} decisions (${r.decisions.fromScan} LLM + ${r.decisions.fromPresets} presets)`);
        }
        if (totalCost > 0) console.log(`  Total cost: $${totalCost.toFixed(2)}`);
        for (const e of [...workspaceResult.errors, ...projectResults.flatMap(r => r.errors)]) {
          console.log(`  Warning: ${e}`);
        }
        generateWorkspaceYaml(projectPath, ws);
      } else {
        const result = await initProjectWithLLM(projectPath, { onProgress: console.log });
        console.log(`  Oracle: ${result.oracle.files} files (${result.oracle.llm ? "LLM scan" : "deterministic fallback"})`);
        console.log(`  Decisions: ${result.decisions.count} (${result.decisions.fromScan} LLM + ${result.decisions.fromPresets} presets)`);
        console.log(`  Memories: ${result.memories.count} (${result.memories.fromPresets} from presets)`);
        console.log(`  Safety: ${result.safety.llm ? "LLM scan" : "defaults + presets"}`);
        if (result.cost.costUsd > 0) console.log(`  Cost: $${result.cost.costUsd.toFixed(2)}, ${(result.durationMs / 1000).toFixed(1)}s`);
        for (const e of result.errors) console.log(`  Warning: ${e}`);
      }

      // Create or update .mcp.json
      const mcpPath = join(projectPath, ".mcp.json");
      let mcpConfig: Record<string, any> = {};
      if (existsSync(mcpPath)) {
        try { mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8")); } catch { mcpConfig = {}; }
      }
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      mcpConfig.mcpServers.axme = { command: "axme-code", args: ["serve"] };
      writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");
      console.log(`  .mcp.json: updated`);

      // Generate CLAUDE.md
      generateClaudeMd(projectPath, isWorkspace);

      // Configure Claude Code hooks in .claude/settings.json
      configureHooks(projectPath);

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

      console.log("\nDone! Run 'claude' to start using AXME tools.");
      break;
    }

    case "serve": {
      await import("./server.js");
      break;
    }

    case "status": {
      const projectPath = resolve(args[1] || ".");
      console.log(statusTool(projectPath));
      break;
    }

    case "hook": {
      const hookName = args[1];
      if (hookName === "post-tool-use") {
        const { runPostToolUseHook } = await import("./hooks/post-tool-use.js");
        await runPostToolUseHook();
      } else if (hookName === "session-end") {
        const { runSessionEndHook } = await import("./hooks/session-end.js");
        await runSessionEndHook();
      }
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
