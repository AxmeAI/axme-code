/**
 * Safety Guardian - deterministic safety rules.
 *
 * Location: .axme-code/safety/rules.yaml
 * No LLM involved - purely rule-based.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { atomicWrite, ensureDir, pathExists } from "./engine.js";
import type { SafetyRules, GitRules, BashRules, FilesystemRules } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

export type SafetyRuleType = "git_protected_branch" | "bash_deny" | "bash_allow" | "fs_deny" | "fs_readonly";

const SAFETY_DIR = "safety";
const RULES_FILE = "rules.yaml";

// --- Defaults ---

const DEFAULT_GIT_RULES: GitRules = {
  protectedBranches: ["main", "master"],
  allowForcePush: false,
  allowDirectPushToMain: false,
  requirePrForMain: true,
};

const DEFAULT_BASH_RULES: BashRules = {
  allowedPrefixes: [
    "ls", "find", "cat", "head", "tail", "wc", "grep", "rg",
    "echo", "pwd", "which", "date", "env",
    "git status", "git log", "git diff", "git branch", "git show", "git rev-parse",
    "go vet", "go build", "go test", "go mod",
    "python -m pytest", "pytest", "npm test", "npm run",
    "cargo check", "cargo test", "cargo build",
    "make test", "make check", "make lint", "make build",
    "tree", "file", "stat", "du",
  ],
  deniedPrefixes: [
    // Destructive system commands
    "rm -rf /", "chmod 777", "curl | sh", "curl | bash", "wget | sh",
    // Destructive git (also enforced by checkGit, belt-and-suspenders)
    "git push --force", "git checkout -- .", "git clean -f",
    // Agent guardrails - publish/release must be human-initiated
    "gh workflow run deploy-prod", "gh release create",
    "npm publish", "twine upload", "docker push",
  ],
  deniedCommands: ["shutdown", "reboot", "halt", "poweroff", "mkfs", "dd if="],
};

const DEFAULT_FS_RULES: FilesystemRules = {
  readOnlyPaths: [],
  deniedPaths: [
    "/etc/passwd", "/etc/shadow",
    "~/.ssh/id_*", "~/.aws/credentials", "~/.gnupg/*",
    ".env", "*.pem", "*.key",
  ],
};

export function defaultRules(): SafetyRules {
  return {
    git: { ...DEFAULT_GIT_RULES },
    bash: {
      allowedPrefixes: [...DEFAULT_BASH_RULES.allowedPrefixes],
      deniedPrefixes: [...DEFAULT_BASH_RULES.deniedPrefixes],
      deniedCommands: [...DEFAULT_BASH_RULES.deniedCommands],
    },
    filesystem: {
      readOnlyPaths: [...DEFAULT_FS_RULES.readOnlyPaths],
      deniedPaths: [...DEFAULT_FS_RULES.deniedPaths],
    },
  };
}

// --- Init / Load ---

export function initSafetyRules(projectPath: string): SafetyRules {
  const rules = defaultRules();
  try {
    const gitConfig = readFileSync(join(projectPath, ".git/config"), "utf-8");
    if (gitConfig.includes('[branch "main"]')) {
      rules.git.protectedBranches = ["main"];
    }
  } catch {}
  writeSafetyRules(projectPath, rules);
  return rules;
}

export function loadSafetyRules(projectPath: string): SafetyRules {
  const rulesPath = join(projectPath, AXME_CODE_DIR, SAFETY_DIR, RULES_FILE);
  if (!pathExists(rulesPath)) return defaultRules();
  try {
    const parsed = yaml.load(readFileSync(rulesPath, "utf-8")) as Partial<SafetyRules>;
    return mergeSafetyRules(defaultRules(), parsed);
  } catch {
    return defaultRules();
  }
}

export function writeSafetyRules(projectPath: string, rules: SafetyRules): void {
  const dir = join(projectPath, AXME_CODE_DIR, SAFETY_DIR);
  ensureDir(dir);
  atomicWrite(join(dir, RULES_FILE), yaml.dump(rules, { lineWidth: 120 }));
}

/**
 * Add or update a safety rule.
 */
export function updateSafetyRule(
  projectPath: string,
  ruleType: "git_protected_branch" | "bash_deny" | "bash_allow" | "fs_deny" | "fs_readonly",
  value: string,
): void {
  const rules = loadSafetyRules(projectPath);

  switch (ruleType) {
    case "git_protected_branch":
      if (!rules.git.protectedBranches.includes(value)) rules.git.protectedBranches.push(value);
      break;
    case "bash_deny":
      if (!rules.bash.deniedPrefixes.includes(value)) rules.bash.deniedPrefixes.push(value);
      break;
    case "bash_allow":
      if (!rules.bash.allowedPrefixes.includes(value)) rules.bash.allowedPrefixes.push(value);
      break;
    case "fs_deny":
      if (!rules.filesystem.deniedPaths.includes(value)) rules.filesystem.deniedPaths.push(value);
      break;
    case "fs_readonly":
      if (!rules.filesystem.readOnlyPaths.includes(value)) rules.filesystem.readOnlyPaths.push(value);
      break;
  }

  writeSafetyRules(projectPath, rules);
}

export function safetyExists(projectPath: string): boolean {
  return pathExists(join(projectPath, AXME_CODE_DIR, SAFETY_DIR, RULES_FILE));
}

export function safetyContext(projectPath: string): string {
  const rules = loadSafetyRules(projectPath);
  const parts: string[] = ["## Safety Rules"];
  if (rules.git.protectedBranches.length > 0) {
    parts.push(`- Protected branches: ${rules.git.protectedBranches.join(", ")}`);
  }
  if (!rules.git.allowForcePush) parts.push("- Force push: DENIED");
  if (!rules.git.allowDirectPushToMain) parts.push("- Direct push to main: DENIED");
  if (rules.bash.deniedPrefixes.length > 0) {
    parts.push(`- Denied commands: ${rules.bash.deniedPrefixes.slice(0, 5).join(", ")}${rules.bash.deniedPrefixes.length > 5 ? "..." : ""}`);
  }
  if (rules.filesystem.deniedPaths.length > 0) {
    parts.push(`- Denied paths: ${rules.filesystem.deniedPaths.slice(0, 5).join(", ")}${rules.filesystem.deniedPaths.length > 5 ? "..." : ""}`);
  }
  return parts.length > 1 ? parts.join("\n") : "";
}

export function showSafety(projectPath: string): string {
  const rules = loadSafetyRules(projectPath);
  return yaml.dump(rules, { lineWidth: 120 });
}

// --- Enforcement ---

export type SafetyVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Strip quoted content from a command string so safety checks
 * don't match text inside commit messages, PR bodies, echo args, etc.
 */
function stripQuoted(command: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "\\" && !inSingle && i + 1 < command.length) { i += 2; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; i++; continue; }
    if (!inSingle && !inDouble) result += ch;
    i++;
  }
  return result;
}

/**
 * Check if a bash command is safe.
 */
export function checkBash(rules: SafetyRules, command: string): SafetyVerdict {
  const stripped = stripQuoted(command.trim());
  const firstCmd = stripped.split("|")[0].trim();
  const pipeNormalized = stripped.split("|").map(s => s.trim().split(/\s+/)[0]).join(" | ");

  for (const denied of rules.bash.deniedCommands) {
    if (stripped.includes(denied)) return { allowed: false, reason: `Denied command: ${denied}` };
  }
  for (const prefix of rules.bash.deniedPrefixes) {
    if (firstCmd.startsWith(prefix)) return { allowed: false, reason: `Denied prefix: ${prefix}` };
    if (prefix.includes("|")) {
      if (pipeNormalized === prefix || pipeNormalized.startsWith(prefix)) {
        return { allowed: false, reason: `Denied prefix: ${prefix}` };
      }
    } else {
      for (const seg of stripped.split("|").map(s => s.trim())) {
        if (seg.startsWith(prefix)) return { allowed: false, reason: `Denied prefix: ${prefix}` };
      }
    }
  }
  return { allowed: true };
}

/**
 * Check if a git operation is safe.
 */
export function checkGit(rules: SafetyRules, command: string): SafetyVerdict {
  const stripped = stripQuoted(command.trim());
  if (!rules.git.allowForcePush && (stripped.includes("--force") || stripped.includes("-f"))) {
    if (stripped.startsWith("git push")) return { allowed: false, reason: "Force push is not allowed" };
  }
  if (!rules.git.allowDirectPushToMain) {
    for (const branch of rules.git.protectedBranches) {
      if (stripped.includes(`push origin ${branch}`) || stripped.includes(`push upstream ${branch}`)) {
        return { allowed: false, reason: `Direct push to ${branch} is not allowed` };
      }
    }
  }
  if (stripped.includes("reset --hard")) {
    return { allowed: false, reason: "git reset --hard is not allowed (destroys uncommitted work)" };
  }
  return { allowed: true };
}

/**
 * Check if a file path is allowed.
 */
export function checkFilePath(rules: SafetyRules, filePath: string, operation: "read" | "write"): SafetyVerdict {
  for (const denied of rules.filesystem.deniedPaths) {
    const pattern = denied.replace("~", process.env.HOME ?? "");
    if (matchesPattern(filePath, pattern)) return { allowed: false, reason: `Path denied: ${denied}` };
  }
  if (operation === "write") {
    for (const readOnly of rules.filesystem.readOnlyPaths) {
      if (filePath.startsWith(readOnly)) return { allowed: false, reason: `Path is read-only: ${readOnly}` };
    }
  }
  return { allowed: true };
}

function matchesPattern(filePath: string, pattern: string): boolean {
  if (filePath === pattern || filePath.startsWith(pattern)) return true;
  const fileName = filePath.split("/").pop() ?? "";
  // Basename match: ".env" matches "/any/path/.env"
  if (fileName === pattern) return true;
  if (pattern.includes("*")) {
    const starIdx = pattern.indexOf("*");
    const prefix = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 1);
    if (prefix === "" && suffix) return filePath.endsWith(suffix) || fileName.endsWith(suffix);
    if (prefix && !suffix) return filePath.startsWith(prefix) || fileName.startsWith(prefix);
    if (prefix && suffix) return (filePath.startsWith(prefix) && filePath.endsWith(suffix)) || (fileName.startsWith(prefix) && fileName.endsWith(suffix));
  }
  return false;
}

// --- Merge ---

function mergeSafetyRules(base: SafetyRules, override: Partial<SafetyRules>): SafetyRules {
  return {
    git: { ...base.git, ...(override.git ?? {}) },
    bash: {
      allowedPrefixes: override.bash?.allowedPrefixes ?? base.bash.allowedPrefixes,
      deniedPrefixes: override.bash?.deniedPrefixes ?? base.bash.deniedPrefixes,
      deniedCommands: override.bash?.deniedCommands ?? base.bash.deniedCommands,
    },
    filesystem: {
      readOnlyPaths: override.filesystem?.readOnlyPaths ?? base.filesystem.readOnlyPaths,
      deniedPaths: override.filesystem?.deniedPaths ?? base.filesystem.deniedPaths,
    },
  };
}

/**
 * Union-merge two SafetyRules — the result ALLOWS what either allows and
 * DENIES what either denies. Used by loadMergedSafetyRules to combine
 * workspace-level base rules with repo-level additions.
 *
 * - protectedBranches: union
 * - allowedPrefixes: union (broadens allow list)
 * - deniedPrefixes / deniedCommands: union (stricter; a deny wins)
 * - deniedPaths / readOnlyPaths: union (stricter)
 * - allowForcePush / allowDirectPushToMain: AND (stricter: both must allow)
 * - requirePrForMain: OR (either requiring is stricter)
 */
function unionMergeSafety(a: SafetyRules, b: SafetyRules): SafetyRules {
  const uniq = (arr: string[]) => Array.from(new Set(arr));
  return {
    git: {
      protectedBranches: uniq([...a.git.protectedBranches, ...b.git.protectedBranches]),
      allowForcePush: a.git.allowForcePush && b.git.allowForcePush,
      allowDirectPushToMain: a.git.allowDirectPushToMain && b.git.allowDirectPushToMain,
      requirePrForMain: a.git.requirePrForMain || b.git.requirePrForMain,
    },
    bash: {
      allowedPrefixes: uniq([...a.bash.allowedPrefixes, ...b.bash.allowedPrefixes]),
      deniedPrefixes: uniq([...a.bash.deniedPrefixes, ...b.bash.deniedPrefixes]),
      deniedCommands: uniq([...a.bash.deniedCommands, ...b.bash.deniedCommands]),
    },
    filesystem: {
      readOnlyPaths: uniq([...a.filesystem.readOnlyPaths, ...b.filesystem.readOnlyPaths]),
      deniedPaths: uniq([...a.filesystem.deniedPaths, ...b.filesystem.deniedPaths]),
    },
  };
}

// --- Scoped storage ---

/**
 * Save a safety rule respecting its scope. If scope is "all" or empty, the
 * rule goes to workspace-level .axme-code/safety/rules.yaml (base rules that
 * apply everywhere). If scope lists specific repos, the rule is written to
 * each repo's own .axme-code/safety/rules.yaml.
 *
 * The PreToolUse hook will union-merge workspace + repo rules at check time.
 */
export function saveScopedSafetyRule(
  ruleType: SafetyRuleType,
  value: string,
  scope: string[] | undefined,
  projectPath: string,
  workspacePath?: string,
): { target: "workspace" | "project" | "scoped"; repos: string[] } {
  // No scope, empty scope, or ["all"] → write to the session origin.
  // If a workspacePath is available (workspace session), write there.
  // Otherwise fall through to projectPath (single-repo session).
  const isAllScope = !scope || scope.length === 0 || (scope.length === 1 && scope[0] === "all");
  if (isAllScope) {
    const target = workspacePath ?? projectPath;
    updateSafetyRule(target, ruleType, value);
    return { target: workspacePath ? "workspace" : "project", repos: [] };
  }

  // Scoped: write to each listed repo (skip "all" if mixed)
  const repos: string[] = [];
  if (workspacePath) {
    for (const repoName of scope) {
      if (repoName === "all") continue;
      const targetPath = resolve(workspacePath, repoName);
      if (pathExists(join(targetPath, ".axme-code")) || pathExists(join(targetPath, ".git"))) {
        updateSafetyRule(targetPath, ruleType, value);
        repos.push(repoName);
      }
    }
  } else {
    // Single-repo session with a scope list: just write to the project
    updateSafetyRule(projectPath, ruleType, value);
    repos.push(projectPath.split("/").pop() ?? "");
  }
  return { target: "scoped", repos };
}

/**
 * Load safety rules merging workspace-level base with the specific repo's
 * override, if any. This is what the PreToolUse hook uses when evaluating
 * a tool call against a file inside a specific repo.
 *
 * If workspacePath is provided AND the file/command belongs to a specific
 * repo, rules from both levels are union-merged (stricter wins on conflicts).
 * Otherwise, just loads rules from projectPath.
 */
export function loadMergedSafetyRules(projectPath: string, workspacePath?: string): SafetyRules {
  const projectRules = loadSafetyRules(projectPath);
  if (!workspacePath || workspacePath === projectPath) return projectRules;
  const workspaceRules = loadSafetyRules(workspacePath);
  return unionMergeSafety(workspaceRules, projectRules);
}
