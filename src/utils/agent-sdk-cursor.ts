/**
 * Cursor SDK wrapper conforming to the AgentSdk interface.
 *
 * Cursor's API is stateful: Agent.create() → agent.send(prompt) →
 * run.stream(). We wrap that into the IDE-agnostic AsyncIterable<AgentMessage>
 * shape so existing audit/scanner stream consumers don't need IDE-specific
 * branches.
 *
 * System-prompt injection: Cursor SDK has no top-level systemPrompt field.
 * The supported way is to prepend a system block to the first send() call
 * (verified by Cursor agent spec-check on PR #129, 2026-05-10). The
 * AgentDefinition.prompt + agentId pattern defines SUBAGENTS spawnable via
 * the Task tool, NOT the outer agent's system prompt.
 *
 * Tool restriction: Cursor's tool taxonomy differs (Bash → Shell, no
 * NotebookEdit/Agent/Skill/etc). agent-options.ts:mapClaudeToolsToCursor()
 * does the translation; values not in Cursor's vocabulary are silently
 * dropped (Cursor doesn't expose them so disallow is a no-op anyway).
 */

import type { AgentRole } from "./agent-options.js";
import type { AgentMessage, AgentQuery, AgentSdk, AgentSdkFactoryOptions } from "./agent-sdk.js";
import { loadCursorApiKey } from "./auth-config.js";

interface CursorRunStream {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

interface CursorRun {
  stream(): CursorRunStream;
  wait?(): Promise<{ status?: string; usage?: AgentMessage["usage"] }>;
}

interface CursorAgentInstance {
  send(prompt: string): Promise<CursorRun>;
  dispose?(): Promise<void>;
}

interface CursorSdkModule {
  Agent: {
    create(opts: {
      apiKey: string;
      model: { id: string };
      local: { cwd: string; settingSources: string[]; mcpServers?: unknown };
      agentId?: string;
      [key: string]: unknown;
    }): Promise<CursorAgentInstance>;
  };
}

function resolveSystemPrompt(q: AgentQuery): string {
  const sp = q.options.systemPrompt;
  if (sp === undefined) return "";
  if (typeof sp === "string") return sp;
  if (Array.isArray(sp)) return sp.join("\n\n");
  // The Claude-Code preset is meaningless for Cursor — only the `append`
  // text contains the role-specific instructions worth forwarding.
  return sp.append ?? "";
}

function buildWrappedPrompt(q: AgentQuery): string {
  const systemPrompt = resolveSystemPrompt(q);
  if (!systemPrompt.trim()) return q.prompt;
  return `<system>\n${systemPrompt}\n</system>\n\n${q.prompt}`;
}

/**
 * Translate one Cursor stream event into our AgentMessage shape.
 * Returns null when the event type is one we deliberately ignore
 * (status/system metadata, unstable tool_call schema, etc.).
 */
function translateCursorEvent(ev: unknown): AgentMessage | null {
  if (!ev || typeof ev !== "object") return null;
  const e = ev as Record<string, unknown>;
  const t = e.type;
  if (t === "assistant") {
    const msg = e.message as { content?: unknown } | undefined;
    type ContentBlocks = NonNullable<AgentMessage["message"]>["content"];
    const content: ContentBlocks = Array.isArray(msg?.content)
      ? (msg.content as ContentBlocks)
      : [];
    return {
      type: "assistant",
      message: { role: "assistant", content },
    };
  }
  if (t === "thinking") {
    const thinking = typeof e.thinking === "string" ? e.thinking : "";
    return {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking }],
      },
    };
  }
  // tool_call, status, system: not consumed by axme-code's auditor /
  // scanner stream loops. Ignore to keep yields clean.
  return null;
}

export async function createCursorAgentSdk(
  _role: AgentRole,
  factoryOpts?: AgentSdkFactoryOptions,
): Promise<AgentSdk> {
  const apiKey = process.env.CURSOR_API_KEY ?? loadCursorApiKey();
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      "CURSOR_API_KEY not configured. Run `axme-code setup --ide=cursor` to save one, " +
        "or export CURSOR_API_KEY in the environment.",
    );
  }

  const cursorMod = (await import("@cursor/sdk")) as unknown as CursorSdkModule;

  return {
    ide: "cursor",
    async *query(q: AgentQuery): AsyncIterable<AgentMessage> {
      const cwd = factoryOpts?.cwd ?? q.options.cwd ?? process.cwd();
      const modelId = q.options.model ?? "composer-2";
      const agent = await cursorMod.Agent.create({
        apiKey,
        model: { id: modelId },
        local: { cwd, settingSources: [], mcpServers: [] },
        agentId: `axme-${_role}`,
      });

      let accumulatedText = "";
      let lastUsage: AgentMessage["usage"] | undefined;
      let runStatus: string | undefined;
      try {
        const run = await agent.send(buildWrappedPrompt(q));
        for await (const ev of run.stream()) {
          const translated = translateCursorEvent(ev);
          if (!translated) continue;
          const msg = translated.message;
          if (translated.type === "assistant" && msg) {
            for (const block of msg.content) {
              if (block.type === "text" && block.text) accumulatedText += block.text;
            }
          }
          yield translated;
        }
        if (run.wait) {
          try {
            const result = await run.wait();
            runStatus = result.status;
            lastUsage = result.usage;
          } catch { /* tolerate wait() unsupported / late errors */ }
        }
      } finally {
        try { await agent.dispose?.(); } catch { /* swallow */ }
      }

      // Synthesize a terminal "result" message so cost-extractor and the
      // existing auditor loop's `if (msg.type === "result")` branch fire
      // exactly once per query.
      yield {
        type: "result",
        subtype: runStatus === "completed" ? "success" : "error",
        result: accumulatedText,
        ...(lastUsage ? { usage: lastUsage } : {}),
      };
    },
  };
}
