/**
 * Shared types for AXME Code MCP server.
 */

// --- Constants ---

export const AXME_CODE_DIR = ".axme-code";
export const DEFAULT_MODEL = "claude-sonnet-4-6";

// --- Workspace ---

export type WorkspaceType =
  | "vscode" | "dotnet" | "jetbrains" | "sublime"
  | "rush" | "pnpm" | "npm" | "yarn" | "lerna" | "nx"
  | "gradle" | "maven" | "submodules" | "multi-git" | "single";

export interface WorkspaceProject {
  path: string;
  name: string;
}

export interface WorkspaceInfo {
  type: WorkspaceType;
  root: string;
  projects: WorkspaceProject[];
  manifestPath: string | null;
}

export interface WorkContext {
  workspacePath: string | null;
  projectPath: string;
  workspace: WorkspaceInfo | null;
}

// --- Oracle ---

export interface OracleFiles {
  stack: string;
  structure: string;
  patterns: string;
  glossary: string;
}

export interface OracleData {
  stack: StackInfo;
  structure: StructureInfo;
  patterns: string;
  glossary: string;
}

export interface StackInfo {
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  testFrameworks: string[];
  packageManager: string | null;
  nodeVersion: string | null;
  pythonVersion: string | null;
  goVersion: string | null;
}

export interface StructureInfo {
  rootFiles: string[];
  directories: DirectoryEntry[];
  entryPoints: string[];
}

export interface DirectoryEntry {
  path: string;
  description: string;
}

export interface OracleScanResult {
  files: OracleFiles;
  durationMs: number;
}

// --- Decision Log ---

export type EnforceLevel = "required" | "advisory";

export interface Decision {
  id: string;
  slug: string;
  title: string;
  decision: string;
  reasoning: string;
  date: string;
  source: "init-scan" | "session" | "manual" | "preset";
  sessionId: string | null;
  enforce: EnforceLevel | null;
  scope?: string[];
}

// --- Memory ---

export type MemoryType = "feedback" | "pattern";

export interface Memory {
  slug: string;
  type: MemoryType;
  title: string;
  description: string;
  keywords: string[];
  source: "init-scan" | "session" | "preset" | "manual";
  sessionId: string | null;
  date: string;
  body: string;
  scope?: string[];
}

// --- Safety ---

export interface SafetyRules {
  git: GitRules;
  bash: BashRules;
  filesystem: FilesystemRules;
}

export interface GitRules {
  protectedBranches: string[];
  allowForcePush: boolean;
  allowDirectPushToMain: boolean;
  requirePrForMain: boolean;
}

export interface BashRules {
  allowedPrefixes: string[];
  deniedPrefixes: string[];
  deniedCommands: string[];
}

export interface FilesystemRules {
  readOnlyPaths: string[];
  deniedPaths: string[];
}

// --- Worklog ---

export type WorklogEventType =
  | "session_start"
  | "session_end"
  | "session_orphan_closed"
  | "agent_turn"
  | "check_result"
  | "memory_saved"
  | "error";

export interface WorklogEvent {
  timestamp: string;
  type: WorklogEventType;
  sessionId: string;
  data: Record<string, unknown>;
}

// --- Session ---

export interface SessionMeta {
  id: string;
  createdAt: string;
  closedAt: string | null;
  turns: number;
  filesChanged: string[];
  /** PID of MCP server process. Used to detect orphaned sessions after crashes. Optional for backward compat. */
  pid?: number;
  /** ISO timestamp when LLM session audit completed. Used to dedupe auto-audit vs startup fallback. */
  auditedAt?: string;
}

// --- Config ---

export interface ProjectConfig {
  model: string;
  reviewEnabled: boolean;
  presets: string[];
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  model: DEFAULT_MODEL,
  reviewEnabled: true,
  presets: ["essential-safety", "ai-agent-guardrails"],
};

// --- Plans ---

export type PlanStatus = "active" | "completed" | "abandoned";
export type StepStatus = "pending" | "in-progress" | "done" | "skipped";
export type AcceptanceRule = "tests-pass" | "e2e-verified" | "user-approved" | "auto";

export interface PlanStep {
  text: string;
  status: StepStatus;
  subPlanId: string | null;
}

export interface Plan {
  id: string;
  slug: string;
  title: string;
  parentId: string | null;
  status: PlanStatus;
  acceptanceRule: AcceptanceRule;
  steps: PlanStep[];
  created: string;
  updated: string;
}

export interface SessionHandoff {
  stoppedAt: string;
  inProgress: string;
  blockers: string;
  next: string;
  dirtyBranches: string;
}

// --- Test Plan ---

export interface TestItem {
  name: string;
  command: string;
  expected: string;
  required: boolean;
}

export interface E2ETestItem extends TestItem {
  manual: boolean;
  instructions?: string;
}

export interface TestPlan {
  auto: TestItem[];
  e2e: E2ETestItem[];
  custom: TestItem[];
}

// --- Deploy Checklist ---

export interface ChecklistItem {
  name: string;
  command: string;
  expected: string;
  required: boolean;
}

export interface DeployChecklist {
  environment: "staging" | "production";
  items: ChecklistItem[];
}

// --- Pricing ---

export type PricingMode = "auto" | "custom" | "tokens_only";

export interface PricingConfig {
  mode: PricingMode;
  inputPer1M?: number;
  outputPer1M?: number;
  cachePer1M?: number;
}

export type VerbosityLevel = "quiet" | "normal" | "verbose" | "debug";
export type AgentPermissionMode = "bypass" | "ask" | "readonly";

export interface AgentPermissions {
  architect: AgentPermissionMode;
  engineer: AgentPermissionMode;
  reviewer: AgentPermissionMode;
  tester: AgentPermissionMode;
}

export const DEFAULT_AGENT_PERMISSIONS: AgentPermissions = {
  architect: "readonly",
  engineer: "bypass",
  reviewer: "readonly",
  tester: "readonly",
};

export type E2EMode = "after-task" | "after-stage" | "manual";
