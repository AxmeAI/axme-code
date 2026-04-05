/**
 * Claude Code transcript parser and filter for the session auditor.
 *
 * Claude Code stores every session as a jsonl file at
 *   ~/.claude/projects/<encoded-path>/<session-id>.jsonl
 *
 * The raw file is large (often 1-2 MB) and ~90% of it is tool_result blocks:
 * bash outputs, file reads, grep matches, etc. The session auditor does not
 * need those — they describe WHAT the code did, which the auditor can see
 * from the code itself and from the diff. What the auditor needs is the
 * CONVERSATION: user corrections, assistant reasoning, assistant findings.
 *
 * This parser drops everything except:
 *   - user text messages (real ones, not IDE notifications)
 *   - assistant text messages >= 80 chars (drops pure transitions)
 *   - assistant thinking blocks
 *   - assistant tool_use blocks (compact form: [ToolName: short params])
 *
 * Typical reduction: 1.4 MB raw → 65 KB filtered (~4%).
 */

import { readFileSync, existsSync } from "node:fs";

export interface ConversationTurn {
  role: "user" | "assistant";
  kind: "text" | "thinking" | "tool_use";
  content: string;
}

export interface ParsedTranscript {
  turns: ConversationTurn[];
  rendered: string;
  rawSize: number;
  filteredSize: number;
  userTurns: number;
  assistantTurns: number;
  thinkingTurns: number;
  toolUseTurns: number;
}

/** Minimum length for assistant text blocks to keep. Shorter is considered a pure transition. */
const MIN_ASSISTANT_TEXT_LENGTH = 80;

/** Maximum characters of tool input to embed inline. */
const TOOL_INPUT_MAX = 200;

/**
 * Render a tool_use block as a compact string for the auditor.
 * We deliberately drop the tool result (it is the 90% of raw transcript).
 */
function shortenToolInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit":
      return input.file_path || input.path || "";
    case "Bash":
      return String(input.command || "").slice(0, TOOL_INPUT_MAX);
    case "Glob":
      return input.pattern || "";
    case "Grep":
      return `"${String(input.pattern || "").slice(0, 100)}"${input.path ? ` in ${input.path}` : ""}`;
    case "WebFetch":
    case "WebSearch":
      return input.url || input.query || "";
    case "TodoWrite":
      return `${(input.todos || []).length} todos`;
    default: {
      const keys = Object.keys(input).slice(0, 3);
      const pairs = keys.map(k => {
        const v = input[k];
        const s = typeof v === "string" ? v.slice(0, 50) : JSON.stringify(v).slice(0, 50);
        return `${k}=${s}`;
      });
      return pairs.join(" ");
    }
  }
}

/**
 * Parse a Claude Code transcript jsonl file into filtered conversation turns.
 * Returns empty turns array if the file does not exist or cannot be read.
 */
export function parseTranscript(path: string): ConversationTurn[] {
  if (!existsSync(path)) return [];

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const turns: ConversationTurn[] = [];
  const lines = content.split("\n").filter(Boolean);

  for (const line of lines) {
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }

    const msg = event.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;

    for (const block of msg.content) {
      const btype = block.type;

      // EXPLICIT SAFEGUARD: skip image blocks. Images (screenshots, attached
      // pictures) are large base64 payloads and carry no useful signal for
      // the auditor. In practice they live inside tool_result blocks which we
      // already ignore, but this explicit skip prevents regression if we ever
      // start processing tool_result partial content.
      if (btype === "image") continue;

      // USER text: drop IDE notifications and system reminders
      if (role === "user" && btype === "text") {
        const text = String(block.text || "").trim();
        if (!text) continue;
        if (text.startsWith("<ide_opened_file>")) continue;
        if (text.startsWith("<ide_selection>")) continue;
        if (text.startsWith("<system-reminder>")) continue;
        if (text.startsWith("<command-name>")) continue;
        if (text.startsWith("<command-message>")) continue;
        if (text.startsWith("Caveat:")) continue;
        turns.push({ role: "user", kind: "text", content: text });
      }

      // ASSISTANT text: keep only substantial messages
      if (role === "assistant" && btype === "text") {
        const text = String(block.text || "").trim();
        if (text.length < MIN_ASSISTANT_TEXT_LENGTH) continue;
        turns.push({ role: "assistant", kind: "text", content: text });
      }

      // ASSISTANT thinking: keep all (critical signal for handoff and reasoning)
      if (role === "assistant" && btype === "thinking") {
        const text = String(block.thinking || "").trim();
        if (!text) continue;
        turns.push({ role: "assistant", kind: "thinking", content: text });
      }

      // ASSISTANT tool_use: compact form, NO tool results
      if (role === "assistant" && btype === "tool_use") {
        const name = String(block.name || "unknown");
        const shortInput = shortenToolInput(name, block.input);
        turns.push({
          role: "assistant",
          kind: "tool_use",
          content: `[${name}${shortInput ? ": " + shortInput : ""}]`,
        });
      }
    }
  }

  return turns;
}

/**
 * Escape XML special characters in content that will go inside a tag.
 * We keep this minimal — only the characters that would break parsing
 * if they appeared literally in the transcript text.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render filtered conversation turns as XML-wrapped structured data.
 *
 * We DO NOT use [USER] / [ASSISTANT] chat-style markers because that
 * triggers the model's chat-continuation pattern-matching and makes the
 * auditor behave as a participant in the conversation instead of an
 * observer extracting from historical data. XML tags are the Anthropic-
 * recommended way to pass structured data in prompts — the model treats
 * them as document markup, not as a chat template.
 *
 * Format:
 *   <session_transcript>
 *     <user_message>...</user_message>
 *     <assistant_thinking>...</assistant_thinking>
 *     <assistant_message>...</assistant_message>
 *     <assistant_tool_calls>[Name: args] [Name: args] ...</assistant_tool_calls>
 *     ...
 *   </session_transcript>
 */
export function renderConversation(turns: ConversationTurn[]): string {
  return renderConversationChunk(turns, { index: 1, total: 1 });
}

/**
 * Render a subset of turns as one chunk, wrapped in
 * <session_transcript_chunk index="N" total="M">...</session_transcript_chunk>
 * when it is part of a multi-chunk audit, or <session_transcript>...</session_transcript>
 * for a single-chunk audit (index=1, total=1).
 */
export function renderConversationChunk(
  turns: ConversationTurn[],
  chunk: { index: number; total: number },
): string {
  const isSingleChunk = chunk.total === 1;
  const openTag = isSingleChunk
    ? "<session_transcript>"
    : `<session_transcript_chunk index="${chunk.index}" total="${chunk.total}">`;
  const closeTag = isSingleChunk
    ? "</session_transcript>"
    : "</session_transcript_chunk>";

  const lines: string[] = [openTag];
  let toolBuffer: string[] = [];

  const flushToolBuffer = () => {
    if (toolBuffer.length > 0) {
      lines.push(`  <assistant_tool_calls>${escapeXml(toolBuffer.join(" "))}</assistant_tool_calls>`);
      toolBuffer = [];
    }
  };

  for (const turn of turns) {
    if (turn.kind === "tool_use") {
      toolBuffer.push(turn.content);
      continue;
    }
    flushToolBuffer();

    if (turn.kind === "thinking") {
      lines.push(`  <assistant_thinking>${escapeXml(turn.content)}</assistant_thinking>`);
    } else if (turn.kind === "text") {
      const tag = turn.role === "user" ? "user_message" : "assistant_message";
      lines.push(`  <${tag}>${escapeXml(turn.content)}</${tag}>`);
    }
  }
  flushToolBuffer();
  lines.push(closeTag);

  return lines.join("\n");
}

/**
 * Estimate the rendered size (in chars) of a single turn when emitted as XML.
 * Used to pack turns into chunks without rendering every possible split.
 */
function estimateTurnRenderSize(turn: ConversationTurn): number {
  // Rough upper bound: content length + tag overhead (~60 chars for open+close+indent).
  return turn.content.length + 60;
}

/**
 * Split a sequence of turns into chunks, each whose rendered size fits under
 * maxCharsPerChunk. Splits happen ONLY on turn boundaries (never mid-thinking,
 * mid-user_message, or mid-assistant_message). If a single turn exceeds the
 * budget on its own (pathological), it gets its own chunk and the caller must
 * decide whether to truncate or skip it — we return it as-is.
 *
 * Returns an array of turn subsets. Render each with renderConversationChunk.
 */
export function splitTurnsIntoChunks(
  turns: ConversationTurn[],
  maxCharsPerChunk: number,
): ConversationTurn[][] {
  if (turns.length === 0) return [];

  // Fast path: everything fits in one chunk.
  const totalSize = turns.reduce((s, t) => s + estimateTurnRenderSize(t), 0);
  // +100 for the XML wrapper tags overhead.
  if (totalSize + 100 <= maxCharsPerChunk) {
    return [turns];
  }

  const chunks: ConversationTurn[][] = [];
  let current: ConversationTurn[] = [];
  let currentSize = 100; // wrapper overhead

  for (const turn of turns) {
    const turnSize = estimateTurnRenderSize(turn);

    // If this turn alone exceeds the budget, flush current chunk and give it
    // its own oversized chunk. Caller can decide how to handle it.
    if (turnSize > maxCharsPerChunk - 100) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
        currentSize = 100;
      }
      chunks.push([turn]);
      continue;
    }

    // If adding this turn would exceed the budget, flush and start a new chunk.
    if (currentSize + turnSize > maxCharsPerChunk) {
      chunks.push(current);
      current = [turn];
      currentSize = 100 + turnSize;
    } else {
      current.push(turn);
      currentSize += turnSize;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Parse a transcript file, filter it, render it, and return stats.
 * Convenience wrapper used by the session auditor.
 */
export function parseAndRenderTranscript(path: string): ParsedTranscript {
  const turns = parseTranscript(path);
  const rendered = renderConversation(turns);

  let rawSize = 0;
  try { rawSize = readFileSync(path, "utf-8").length; } catch {}

  return {
    turns,
    rendered,
    rawSize,
    filteredSize: rendered.length,
    userTurns: turns.filter(t => t.role === "user" && t.kind === "text").length,
    assistantTurns: turns.filter(t => t.role === "assistant" && t.kind === "text").length,
    thinkingTurns: turns.filter(t => t.kind === "thinking").length,
    toolUseTurns: turns.filter(t => t.kind === "tool_use").length,
  };
}

/**
 * Parse and render multiple transcripts (for multi-agent sessions), joining
 * them with role labels so the auditor can distinguish which agent said what.
 * Also returns the combined turns list for downstream chunking.
 */
export function parseAndRenderTranscripts(
  refs: Array<{ id: string; transcriptPath: string; role?: string }>,
): {
  rendered: string;
  totalRaw: number;
  totalFiltered: number;
  /** Combined turns across all refs, for chunking in the auditor. */
  allTurns: ConversationTurn[];
} {
  if (refs.length === 0) return { rendered: "", totalRaw: 0, totalFiltered: 0, allTurns: [] };
  if (refs.length === 1) {
    const parsed = parseAndRenderTranscript(refs[0].transcriptPath);
    return {
      rendered: parsed.rendered,
      totalRaw: parsed.rawSize,
      totalFiltered: parsed.filteredSize,
      allTurns: parsed.turns,
    };
  }

  const parts: string[] = [];
  let totalRaw = 0;
  let totalFiltered = 0;
  const allTurns: ConversationTurn[] = [];
  for (const ref of refs) {
    const parsed = parseAndRenderTranscript(ref.transcriptPath);
    if (parsed.rendered.length === 0) continue;
    parts.push(`==== AGENT: ${ref.role ?? "main"} (session ${ref.id}) ====`);
    parts.push(parsed.rendered);
    parts.push("");
    totalRaw += parsed.rawSize;
    totalFiltered += parsed.filteredSize;
    allTurns.push(...parsed.turns);
  }
  return { rendered: parts.join("\n"), totalRaw, totalFiltered, allTurns };
}
