/**
 * Memory Extractor Agent - post-session LLM analysis.
 *
 * Reads session worklog and extracts:
 * - Error patterns (feedback): "tried X, failed because Y"
 * - Successful approaches (patterns): "for task type Z, approach W works"
 *
 * Model: Haiku (cost efficient, read-only analysis)
 * Budget: $0.50 max
 */

import type { Memory } from "../types.js";
import { extractCostFromResult, zeroCost, type CostInfo } from "../utils/cost-extractor.js";
import { toMemorySlug } from "../storage/memory.js";
import { readConfig } from "../storage/config.js";
import { twoLevelFormatRule, SELECTION_TEST } from "../storage/kb-format.js";
import { buildAgentEnv, claudePathForSdk } from "../utils/agent-options.js";
import { createAgentSdk } from "../utils/agent-sdk.js";

export interface MemoryExtractionResult {
  memories: Memory[];
  cost: CostInfo;
  durationMs: number;
}

/**
 * Builder rather than a constant so the format contract quotes THIS
 * project's catalog budget. The previous constant told the extractor
 * "body: keep short or omit — description must carry all meaning", which is
 * the exact inversion of the contract and a direct contributor to 91% of one
 * base's memories sitting entirely in the layer paid for by every session.
 */
const buildExtractionPrompt = (excerptChars: number): string => `You are a learning system that extracts memories from coding sessions.

Analyze the session transcript below and extract two types of memories:

1. **Feedback** (type: "feedback"): Things that went wrong, mistakes made, errors encountered.
   - What was tried and why it failed
   - What the correct approach turned out to be
   - Anti-patterns to avoid in future sessions

2. **Patterns** (type: "pattern"): Approaches that worked well and should be repeated.
   - Successful strategies for specific task types
   - Efficient workflows that saved time
   - Non-obvious solutions that worked

${twoLevelFormatRule(excerptChars)}

${SELECTION_TEST}

For each memory, output in this exact format (one block per memory):

###MEMORY###
slug: <kebab-case, max 60 chars. Transliterate non-Latin titles; never leave this empty.>
type: <feedback or pattern>
title: <one-line summary, max 80 chars>
description: <LOADED LAYER — the rule plus one concrete fact, 1-2 sentences, at most ${excerptChars} characters. Loaded into every future session.>
keywords: <3-7 keywords, comma-separated>
scope: <comma-separated project names this applies to, or "all" for universal>
body: <DEFERRED LAYER — every number, file path, line reference, threshold, measurement and command output. NOT loaded at session start; returned by axme_get_memory. Use it freely; leave empty only when there is genuinely no detail.>
###END###

Rules:
- Only extract memories that would be useful in FUTURE sessions
- Skip trivial or one-off issues (typos, syntax errors)
- Focus on patterns that are likely to recur
- Be specific, not generic ("always use AsyncClient in FastAPI handlers" > "use async")
- If the session had no notable errors or patterns, output nothing
- **scope**: if a memory is specific to this project only, use the project name. If it applies to multiple projects, list them. Use "all" only for truly universal rules.

===END===`;

/**
 * Run post-session memory extraction.
 */
export async function runMemoryExtraction(opts: {
  sessionId: string;
  sessionEvents: string;
  projectPath: string;
  model?: string;
}): Promise<MemoryExtractionResult> {
  const sdk = await createAgentSdk("auditor", { cwd: opts.projectPath });
  const startTime = Date.now();
  const model = opts.model ?? "claude-haiku-4-5";

  const claudePath = claudePathForSdk();
  const queryOpts = {
    cwd: opts.projectPath,
    model,
    ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    allowedTools: [] as string[],
    disallowedTools: ["Write", "Edit", "Bash", "Glob", "Grep", "Read", "Agent", "NotebookEdit", "Skill", "TodoWrite"],
    env: buildAgentEnv(),
  };

  const prompt = `${buildExtractionPrompt(readConfig(opts.projectPath).catalogExcerptChars)}\n\nSession ID: ${opts.sessionId}\n\nSession transcript:\n${opts.sessionEvents}`;
  const q = sdk.query({ prompt, options: queryOpts });

  let result = "";
  let cost: CostInfo | undefined;

  for await (const msg of q) {
    if (msg.type === "assistant") {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) result += block.text;
        }
      }
    }
    if (msg.type === "result") {
      cost = extractCostFromResult(msg);
      if ((msg as any).subtype === "success" && (msg as any).result) {
        result = (msg as any).result;
      }
    }
  }

  const memories = parseMemoryOutput(result, opts.sessionId);
  if (!cost) cost = zeroCost();

  return { memories, cost, durationMs: Date.now() - startTime };
}

/**
 * Parse LLM output into Memory objects.
 */
export function parseMemoryOutput(output: string, sessionId: string): Memory[] {
  const today = new Date().toISOString().slice(0, 10);
  const memories: Memory[] = [];

  const blocks = output.matchAll(/###MEMORY###\n([\s\S]*?)###END###/g);

  for (const match of blocks) {
    const block = match[1];
    const get = (key: string): string => {
      const m = block.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
      return m ? m[1].trim() : "";
    };

    const slug = toMemorySlug(get("slug"));
    const type = get("type");
    const title = get("title");
    const description = get("description");
    const keywordsRaw = get("keywords");
    const keywords = keywordsRaw ? keywordsRaw.split(",").map(k => k.trim()).filter(Boolean) : [];
    const scopeRaw = get("scope");
    const scope = scopeRaw ? scopeRaw.split(",").map(s => s.trim()).filter(Boolean) : undefined;

    const bodyMatch = block.match(/^body:\s*([\s\S]*)$/m);
    const body = bodyMatch ? bodyMatch[1].trim() : "";

    if (!slug || !title || (type !== "feedback" && type !== "pattern")) continue;

    memories.push({
      slug, type: type as "feedback" | "pattern",
      title, description, keywords,
      source: "session", sessionId, date: today, body,
      ...(scope ? { scope } : {}),
    });
  }

  return memories;
}
