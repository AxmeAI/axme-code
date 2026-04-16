/**
 * Shared types for AXME Code MCP server.
 */

// --- Build-time constants (replaced by esbuild define) ---
declare const __VERSION__: string;
export const AXME_CODE_VERSION: string = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";

// --- Constants ---

export const AXME_CODE_DIR = ".axme-code";
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_AUDITOR_MODEL = "claude-sonnet-4-6";

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
export type DecisionStatus = "active" | "superseded" | "deprecated" | "revoked";

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
  /** Lifecycle status. Undefined treated as "active" for backward compat. */
  status?: DecisionStatus;
  /** ID of the decision that replaced this one (set when superseded). */
  supersededBy?: string;
  /** IDs of decisions this one replaces (set on the newer decision). */
  supersedes?: string[];
  /** ISO timestamp when revoked. */
  revokedAt?: string;
  /** Reason for revocation. */
  revokedReason?: string;
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
  | "session_orphan_audit_queued"
  | "safety_block"
  | "safety_updated"
  | "check_result"
  | "audit_complete"
  | "decision_saved"
  | "decision_superseded"
  | "memory_saved"
  | "error";

export interface WorklogEvent {
  timestamp: string;
  type: WorklogEventType;
  sessionId: string;
  data: Record<string, unknown>;
}

// --- Session ---

/**
 * A Claude Code (or future multi-agent) session attached to an AXME session.
 * One AXME session can have multiple attached Claude Code sessions when
 * tester/reviewer sub-agents join in later phases.
 */
export interface ClaudeSessionRef {
  /** Claude Code's own session_id (from hook event input) */
  id: string;
  /** Absolute path to the Claude Code transcript jsonl file */
  transcriptPath: string;
  /** ISO timestamp when this Claude session was first seen in a hook event */
  firstSeen: string;
  /** Role in the AXME session. Defaults to "main". Reserved for future multi-agent. */
  role?: string;
}

/**
 * Status of the LLM audit lifecycle on this session. Used to prevent parallel
 * auditors racing on the same session without file locks.
 *
 * Lifecycle:
 *   undefined → "pending" (audit starts, auditStartedAt set)
 *   "pending" → "done"    (audit succeeded, auditFinishedAt + auditedAt set)
 *   "pending" → "failed"  (audit threw, lastAuditError set)
 *
 * A "pending" status older than 15 minutes is considered stale (crashed
 * auditor) and can be retried — this is the simple cross-process recovery
 * that replaces the old pending-audits/ marker files + file lock approach.
 */
export type AuditStatus = "pending" | "done" | "failed";

export interface SessionMeta {
  id: string;
  createdAt: string;
  closedAt: string | null;
  filesChanged: string[];
  /**
   * Absolute path to the directory where the MCP server was running when
   * this session was created. This is the authoritative "session origin"
   * and the parent of the .axme-code/ directory that contains this session.
   *
   * Why we store it: an operator (or an agent that picked up the meta.json
   * directly instead of going through axme_context) can look at this field
   * and know exactly which .axme-code/ storage this session belongs to. In
   * a multi-repo workspace the workspace root and each child repo each
   * have their own .axme-code/, and cwd-relative lookups are ambiguous.
   * `origin` removes the ambiguity: it is always absolute, always points to
   * the correct storage root (origin + "/.axme-code"), and never changes
   * after session creation.
   *
   * Optional for backward compat with sessions created before this field
   * was added.
   */
  origin?: string;
  /** PID of the Claude Code process that owns this session. Used by orphan cleanup. Optional for backward compat. */
  pid?: number;
  /** ISO timestamp when LLM session audit completed. Used to dedupe auto-audit vs startup fallback. */
  auditedAt?: string;
  /** Claude Code sessions attached to this AXME session (populated by hooks). */
  claudeSessions?: ClaudeSessionRef[];
  /** Number of times the auditor has been invoked on this session. Capped by MAX_AUDIT_ATTEMPTS. */
  auditAttempts?: number;
  /** Error message from the most recent failed audit attempt, if any. Cleared on successful audit. */
  lastAuditError?: string;
  /** Audit lifecycle flag. Replaces the old pending-audits/ marker files. */
  auditStatus?: AuditStatus;
  /** ISO timestamp when the current audit attempt started (only meaningful when auditStatus === "pending"). */
  auditStartedAt?: string;
  /** ISO timestamp when the most recent audit attempt finished (success or failure). */
  auditFinishedAt?: string;
  /** True if the agent completed the close checklist (axme_finalize_close called).
   *  When true, the auditor runs in verify-only mode instead of full extraction. */
  agentClosed?: boolean;
}

// --- Config ---

export interface ProjectConfig {
  /** Default model for agent sessions (architect, engineer, reviewer, tester) */
  model: string;
  /** Model for the session auditor (extracts memories/decisions/safety at session end) */
  auditorModel: string;
  reviewEnabled: boolean;
  presets: string[];
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  model: DEFAULT_MODEL,
  auditorModel: DEFAULT_AUDITOR_MODEL,
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
  /** Enriched fields (optional for backward compat with auditor extraction). */
  sessionId?: string;
  date?: string;
  summary?: string;
  prs?: Array<{ url: string; title: string; status: string }>;
  testResults?: string;
  source?: "agent" | "auditor";
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

// --- Auth ---

export type AuthMode = "subscription" | "api_key";

export interface AuthConfig {
  mode: AuthMode;
  chosenAt: string;
}
