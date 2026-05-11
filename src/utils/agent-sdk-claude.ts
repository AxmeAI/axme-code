/**
 * Claude Agent SDK wrapper conforming to the AgentSdk interface.
 *
 * Thin pass-through over `await import("@anthropic-ai/claude-agent-sdk")`.
 * Today's hot path: every `for await (const msg of q)` loop in
 * src/agents/* receives the raw SDK message stream — we yield it as-is
 * and rely on the AgentMessage shape being a superset of the Claude SDK
 * Message envelope.
 */

import type { AgentRole } from "./agent-options.js";
import type { AgentMessage, AgentQuery, AgentSdk } from "./agent-sdk.js";

export function createClaudeAgentSdk(_role: AgentRole): AgentSdk {
  return {
    ide: "claude-code",
    async *query(q: AgentQuery): AsyncIterable<AgentMessage> {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      // The Claude SDK's Options type is the source of truth here; we
      // pass our AgentQuery options through with a structural cast.
      // Callers (buildAgentQueryOptions) already produce the right shape.
      const stream = sdk.query({
        prompt: q.prompt,
        options: q.options as unknown as Parameters<typeof sdk.query>[0]["options"],
      });
      for await (const msg of stream) {
        yield msg as unknown as AgentMessage;
      }
    },
  };
}
