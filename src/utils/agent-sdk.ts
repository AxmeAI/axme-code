/**
 * IDE-agnostic LLM agent SDK abstraction.
 *
 * Two concrete implementations: Claude (via @anthropic-ai/claude-agent-sdk)
 * and Cursor (via @cursor/sdk). The factory picks the right one based on
 * the user's AuthMode + IDE, with a fallback chain:
 *
 *   1. preferred IDE (from opts, env AXME_IDE, or auth.yaml mode)
 *   2. if cursor: try @cursor/sdk import; on win-arm64 / missing module
 *      / missing CURSOR_API_KEY → warn + fall back
 *   3. if claude: require findClaudePath() OR ANTHROPIC_API_KEY
 *   4. else: throw AgentSdkUnavailableError — caller (audit worker) catches,
 *      writes one log line, exits 0
 *
 * AgentMessage shape mirrors the Claude Agent SDK envelope so existing
 * stream-consumption loops in src/agents/* keep working unchanged. The
 * Cursor wrapper translates Cursor's discriminated event types into this
 * shape on the fly.
 */

import type { AgentRole } from "./agent-options.js";
import type { IdeKind } from "../types.js";
import { resolveAuthMode } from "./auth-config.js";
import { findClaudePath } from "./agent-options.js";
import { detectIdeFromEnv } from "./ide-detect.js";

export type AgentMessageKind = "assistant" | "thinking" | "tool_use" | "result" | "system";

export interface AgentMessage {
  type: AgentMessageKind;
  message?: {
    role: "assistant" | "user";
    content: Array<{
      type: "text" | "thinking" | "tool_use";
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  result?: string;
  subtype?: "success" | "error";
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  // Allow concrete implementations to forward additional fields the
  // Claude SDK exposes (modelUsage, cost-extractor sub-keys, etc.).
  [key: string]: unknown;
}

/**
 * AgentQuery.options is intentionally permissive — every field is optional,
 * so existing call sites built via `buildAgentQueryOptions(...)` (which
 * returns the Claude Agent SDK `Options` type, where most fields are
 * declared optional) type-check without rewrapping. The Claude wrapper
 * passes the object straight to `sdk.query()`. The Cursor wrapper reads
 * only the fields it needs (`cwd`, `model`, `systemPrompt`) and ignores
 * the rest.
 */
export interface AgentQueryOptions {
  cwd?: string;
  model?: string;
  systemPrompt?:
    | string
    | string[]
    | { type: "preset"; preset: "claude_code"; append?: string; excludeDynamicSections?: boolean };
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  env?: NodeJS.ProcessEnv;
  settingSources?: string[];
  permissionMode?: string;
  pathToClaudeCodeExecutable?: string;
  [key: string]: unknown;
}

export interface AgentQuery {
  prompt: string;
  options: AgentQueryOptions;
}

export interface AgentSdk {
  readonly ide: IdeKind;
  query(q: AgentQuery): AsyncIterable<AgentMessage>;
}

export interface AgentSdkFactoryOptions {
  /** Override IDE selection. Falls through to AXME_IDE env, then auth.yaml. */
  preferredIde?: IdeKind;
  /** Forwarded to wrappers that need a project root (Cursor SDK takes it
   *  as `local.cwd`). When omitted, wrappers fall back to options.cwd
   *  from the AgentQuery. */
  cwd?: string;
}

/**
 * Thrown when no LLM backend is usable. The detached audit worker catches
 * this and writes a single log line — it never crashes the parent or
 * triggers a retry loop.
 */
export class AgentSdkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSdkUnavailableError";
  }
}

function authImpliedIde(): IdeKind | undefined {
  try {
    const mode = resolveAuthMode();
    if (mode === "cursor_sdk") return "cursor";
    if (mode === "subscription" || mode === "api_key") return "claude-code";
  } catch { /* swallow */ }
  return undefined;
}

function selectIde(opts?: AgentSdkFactoryOptions): IdeKind {
  return opts?.preferredIde
    ?? detectIdeFromEnv()
    ?? authImpliedIde()
    ?? "claude-code";
}

/**
 * Create an AgentSdk for the requested role. Lazy-imports the concrete
 * wrapper module so unused providers never inflate the cold-start cost.
 */
export async function createAgentSdk(
  role: AgentRole,
  opts?: AgentSdkFactoryOptions,
): Promise<AgentSdk> {
  const ide = selectIde(opts);

  if (ide === "cursor") {
    if (process.platform === "win32" && process.arch === "arm64") {
      logFallback("@cursor/sdk has no win-arm64 native binary");
      return await createClaudeFallback(role);
    }
    try {
      const { createCursorAgentSdk } = await import("./agent-sdk-cursor.js");
      const cursor = await createCursorAgentSdk(role, opts);
      return cursor;
    } catch (err) {
      logFallback(`@cursor/sdk import failed: ${(err as Error).message}`);
      return await createClaudeFallback(role);
    }
  }

  return await createClaudeFallback(role);
}

/**
 * Log a quiet, single-line message about an expected-fallback case (e.g.
 * @cursor/sdk not bundled in the VS Code extension, so we route to the
 * Claude SDK instead). Hidden by default — only surfaces when the
 * AXME_VERBOSE_FALLBACK env var is set. Users almost never need to see
 * these; they're meaningful only when debugging the factory routing.
 */
function logFallback(reason: string): void {
  if (process.env.AXME_VERBOSE_FALLBACK) {
    process.stderr.write(`AXME: routing through Claude SDK (${reason})\n`);
  }
}

async function createClaudeFallback(role: AgentRole): Promise<AgentSdk> {
  const haveBinary = !!findClaudePath();
  const haveKey = !!process.env.ANTHROPIC_API_KEY;
  if (!haveBinary && !haveKey) {
    throw new AgentSdkUnavailableError(
      "No usable LLM backend. Install @cursor/sdk + set CURSOR_API_KEY (Cursor users), " +
        "or install `claude` and run `claude /login` (subscription users), " +
        "or set ANTHROPIC_API_KEY (API users).",
    );
  }
  const { createClaudeAgentSdk } = await import("./agent-sdk-claude.js");
  return createClaudeAgentSdk(role);
}
