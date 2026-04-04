/**
 * Shared types for AXME Code MCP server.
 */

// --- Constants ---

export const AXME_CODE_DIR = ".axme-code";
export const DEFAULT_MODEL = "claude-sonnet-4-6";

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
  source: "session" | "preset" | "manual";
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

// --- Test Plan ---

export interface TestItem {
  name: string;
  command: string;
  expected: string;
  required: boolean;
}

export interface TestPlan {
  auto: TestItem[];
  e2e: TestItem[];
  custom: TestItem[];
}

// --- Deploy Checklist ---

export interface ChecklistItem {
  name: string;
  command: string;
  expected: string;
  required: boolean;
}
