/**
 * Shared agent query options builder for LLM scanner agents.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveAuthMode } from "./auth-config.js";

type Options = import("@anthropic-ai/claude-agent-sdk").Options;

/**
 * Find the `claude` CLI binary path. Cached after first successful lookup.
 *
 * The Claude Agent SDK resolves its own executable via `import.meta.url`,
 * which is `undefined` inside our bundled CJS builds and crashes with
 * `fileURLToPath(undefined)` (B-006 / D-121). Every `sdk.query()` call must
 * set `pathToClaudeCodeExecutable` to the result of this function.
 *
 * Resolution order (B-009 — first match wins):
 *   1. `AXME_CLAUDE_EXECUTABLE` env var — explicit override for CI / unusual installs
 *   2. `CLAUDE_CODE_ENTRYPOINT` env var — set by Claude Code itself in some contexts
 *   3. `which claude` — standard PATH lookup (works on most dev machines)
 *   4. Standard install locations (no PATH dependency):
 *      - ~/.local/bin/claude
 *      - /usr/local/bin/claude
 *      - /opt/homebrew/bin/claude (macOS Apple Silicon)
 *      - /usr/bin/claude
 *   5. nvm-managed installs: ~/.nvm/versions/node/* /bin/claude
 *
 * Returns undefined only if none of the above yields a readable file.
 * Callers should treat undefined as "claude not installed" and either
 * fail-fast with an actionable message or skip the LLM call.
 */
let _claudePath: string | undefined;
export function findClaudePath(): string | undefined {
  if (_claudePath !== undefined) return _claudePath || undefined;

  // 1. Explicit override
  if (process.env.AXME_CLAUDE_EXECUTABLE && existsSync(process.env.AXME_CLAUDE_EXECUTABLE)) {
    _claudePath = process.env.AXME_CLAUDE_EXECUTABLE;
    return _claudePath;
  }

  // 2. SDK's own env var
  if (process.env.CLAUDE_CODE_ENTRYPOINT && existsSync(process.env.CLAUDE_CODE_ENTRYPOINT)) {
    _claudePath = process.env.CLAUDE_CODE_ENTRYPOINT;
    return _claudePath;
  }

  // 3. PATH lookup — `which` on POSIX, `where.exe` on Windows.
  // Use stdio:['ignore','pipe','ignore'] to suppress stderr leakage (Windows
  // PowerShell renders tool-not-found messages even when we try/catch).
  try {
    const lookup = process.platform === "win32" ? "where.exe claude" : "which claude";
    const p = execSync(lookup, { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const lines = p.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // On Windows, `where.exe claude` returns every matching entry including
    // the bare-name shebang file that npm ships for Unix compatibility
    // (e.g. C:\node\claude with no extension). cmd.exe / the Agent SDK
    // cannot execute such files — they need .cmd/.exe/.bat/.ps1. Pick the
    // first Windows-executable from the list; fall back to the first entry
    // only if nothing else matches (unlikely but keeps behaviour defined).
    const preferred = process.platform === "win32"
      ? lines.find((r) => /\.(cmd|exe|bat|ps1)$/i.test(r))
      : undefined;
    const first = preferred ?? lines[0];
    if (first && existsSync(first)) {
      _claudePath = first;
      return _claudePath;
    }
  } catch { /* not in PATH — continue to standard locations */ }

  // 4. Standard install locations
  const home = homedir();
  const standardPaths = [
    join(home, ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    "/usr/bin/claude",
  ];
  for (const candidate of standardPaths) {
    if (existsSync(candidate)) {
      _claudePath = candidate;
      return _claudePath;
    }
  }

  // 5. nvm-managed installs (common on dev machines)
  try {
    const nvmDir = join(home, ".nvm", "versions", "node");
    if (existsSync(nvmDir)) {
      for (const ver of readdirSync(nvmDir)) {
        const candidate = join(nvmDir, ver, "bin", "claude");
        if (existsSync(candidate)) {
          _claudePath = candidate;
          return _claudePath;
        }
      }
    }
  } catch { /* nvm not present — fine */ }

  _claudePath = "";
  return undefined;
}

/** @internal Reset cached claude path. Used in tests only. */
export function _resetFindClaudePath(): void {
  _claudePath = undefined;
}

/**
 * Value to pass as the SDK's `pathToClaudeCodeExecutable` option.
 *
 * On POSIX this is the same as findClaudePath() — the SDK needs the concrete
 * path because its own `require.resolve("./cli.js")` fallback can hit
 * `fileURLToPath(undefined)` inside CJS bundles (B-006 / D-121).
 *
 * On Windows we return undefined, deliberately. The SDK's fallback in its own
 * bundled cli.js path works correctly there; meanwhile passing our PATH-
 * resolved `claude.cmd` triggers `spawn EINVAL` on every call because Node's
 * child_process.spawn refuses .cmd/.bat without `shell: true` since CVE-
 * 2024-27980, and the SDK does not set shell:true. Every site that constructs
 * queryOpts and calls `sdk.query()` MUST use this helper, not findClaudePath
 * directly, otherwise scanners/auditor/extractor all break on Windows.
 */
export function claudePathForSdk(): string | undefined {
  return process.platform === "win32" ? undefined : findClaudePath();
}

export type AgentRole = "scanner" | "tester" | "reviewer" | "engineer" | "architect" | "auditor";

const ROLE_TOOLS: Record<AgentRole, { allowed: string[]; disallowed: string[] }> = {
  auditor: {
    allowed: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "Agent"],
    disallowed: ["WebFetch", "WebSearch", "TodoWrite", "Skill", "NotebookEdit", "ToolSearch"],
  },
  scanner: {
    allowed: ["Read", "Glob", "Grep", "Bash"],
    disallowed: ["Write", "Edit", "Agent", "NotebookEdit", "Skill", "TodoWrite"],
  },
  tester: {
    allowed: ["Read", "Glob", "Grep", "Bash"],
    disallowed: ["Edit", "Write", "Agent", "TodoWrite", "NotebookEdit", "Skill"],
  },
  reviewer: {
    allowed: ["Read", "Glob", "Grep", "Bash"],
    disallowed: ["Edit", "Write", "Agent", "TodoWrite", "NotebookEdit", "Skill"],
  },
  engineer: {
    allowed: ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "Agent", "TodoWrite", "NotebookEdit"],
    disallowed: ["Skill"],
  },
  architect: {
    allowed: ["Read", "Glob", "Grep"],
    disallowed: ["Write", "Edit", "Bash", "Agent", "NotebookEdit", "Skill", "TodoWrite"],
  },
};

/**
 * Build the env passed to every Claude Code subprocess we spawn for LLM work.
 *
 * Two things happen here:
 *   1. `AXME_TELEMETRY_DISABLED` and `AXME_SKIP_HOOKS` are set to suppress
 *      recursive startup events and ghost AXME sessions when the sub-claude
 *      inadvertently launches axme-code as its own MCP server.
 *   2. If the user has selected `subscription` as the auth mode (either via
 *      `axme-code auth` / `axme-code setup`, or by heuristic when only the
 *      subscription is detected), we delete `ANTHROPIC_API_KEY` before
 *      handing env to the subprocess. Claude Code checks the env var before
 *      its OAuth credentials, so leaving an empty-balance key in env would
 *      surface as "Credit balance is too low" or 401 auth errors even when
 *      the user has an active subscription. Delete, not empty string: Claude
 *      Code treats an empty-string value as "set" and still prefers it over
 *      OAuth.
 */
export function buildAgentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AXME_TELEMETRY_DISABLED: "1",
    AXME_SKIP_HOOKS: "1",
  };
  if (resolveAuthMode() === "subscription") {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

export function buildAgentQueryOptions(base: {
  cwd: string;
  model: string;
  maxTurns?: number;
  agentPrompt?: string;
}, role: AgentRole): Options {
  const tools = ROLE_TOOLS[role];

  // See claudePathForSdk() docstring for why this isn't just findClaudePath().
  const claudePath = claudePathForSdk();

  return {
    cwd: base.cwd,
    model: base.model,
    systemPrompt: base.agentPrompt
      ? { type: "preset" as const, preset: "claude_code" as const, append: base.agentPrompt }
      : { type: "preset" as const, preset: "claude_code" as const },
    settingSources: ["project"],
    ...(base.maxTurns !== undefined ? { maxTurns: base.maxTurns } : {}),
    ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: tools.allowed,
    disallowedTools: tools.disallowed,
    includePartialMessages: true,
    env: buildAgentEnv(),
  };
}
