/**
 * IDE-agnostic transcript parser and filter for the session auditor.
 *
 * Two transcript shapes are supported, picked at parse time via the
 * optional `ide` parameter:
 *
 * - **Claude Code** (`~/.claude/projects/<encoded-path>/<session-id>.jsonl`):
 *   each line is `{ message: { role, content: [...] } }`. Role is nested
 *   inside the `message` envelope. Content blocks include `text`,
 *   `thinking`, `tool_use`, `tool_result`, `image`.
 *
 * - **Cursor** (`~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`):
 *   each line is `{ role, message: { content: [...] } }`. Role is at the
 *   TOP level. Content blocks observed in the wild are text-only — Cursor's
 *   stored transcript does not include tool_use / thinking / tool_result.
 *   The parser still tolerates them defensively in case future Cursor
 *   versions add richer events.
 *
 * The raw Claude file is large (often 1-2 MB) and ~90% of it is tool_result
 * blocks: bash outputs, file reads, grep matches, etc. The session auditor
 * does not need those — they describe WHAT the code did, which the auditor
 * can see from the code itself and from the diff. What the auditor needs is
 * the CONVERSATION: user corrections, assistant reasoning, assistant
 * findings. This parser drops everything except:
 *   - user text messages (real ones, not IDE notifications)
 *   - assistant text messages >= 80 chars (drops pure transitions)
 *   - assistant thinking blocks
 *   - assistant tool_use blocks (compact form: [ToolName: short params])
 *
 * Typical reduction (Claude): 1.4 MB raw → 65 KB filtered (~4%). Cursor
 * transcripts are usually smaller because they have no tool_result.
 */

import { readFileSync, existsSync } from "node:fs";
import type { IdeKind } from "./types.js";

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
        let s: string;
        try { s = typeof v === "string" ? v.slice(0, 50) : JSON.stringify(v).slice(0, 50); }
        catch { s = "[object]"; }
        return `${k}=${s}`;
      });
      return pairs.join(" ");
    }
  }
}

/**
 * Result of parsing a transcript slice. endOffset is the byte position in
 * the file where we stopped — store this so a subsequent audit can resume
 * from it and avoid burning LLM tokens on already-audited turns.
 */
export interface ParsedTranscriptSlice {
  turns: ConversationTurn[];
  /** Absolute byte offset at the end of the parsed portion. Always a line boundary. */
  endOffset: number;
  /** Bytes consumed on this call. 0 when the file has not grown since last audit. */
  bytesRead: number;
  /** Total file size in bytes at read time (for logging). */
  fileSize: number;
  /** Raw bash command strings from Bash tool_use blocks. Used by session-cleanup
   *  to supplement filesChanged with paths extracted from shell commands. */
  bashCommands: string[];
}

/**
 * Parse a Claude Code transcript jsonl file into filtered conversation turns,
 * optionally starting from a byte offset (for resume-audit optimization).
 *
 * Works on Buffer (bytes), not String (UTF-16 code units), so offsets are
 * true byte positions safe for multibyte characters. The caller is expected
 * to always pass line-aligned offsets — in practice this is guaranteed
 * because we only ever write endOffset values that we recorded at the end
 * of parsing (which is always a line boundary since Claude Code writes full
 * lines atomically).
 *
 * Returns empty turns and endOffset=startOffset if the file does not exist,
 * cannot be read, or the offset is beyond file size (treated as "file was
 * rotated / shortened", safe no-op).
 */
export function parseTranscriptFromOffset(
  path: string,
  startOffset: number = 0,
  ide: IdeKind = "claude-code",
): ParsedTranscriptSlice {
  if (!existsSync(path)) {
    return { turns: [], endOffset: startOffset, bytesRead: 0, fileSize: 0, bashCommands: [] };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return { turns: [], endOffset: startOffset, bytesRead: 0, fileSize: 0, bashCommands: [] };
  }

  const fileSize = buffer.length;

  // Guard: if the stored offset is beyond current file size, the file was
  // rotated or truncated by Claude Code. Reset to 0 and parse from scratch.
  // (In practice Claude Code appends monotonically, but this handles edge
  // cases like manual deletes or "resume from older point".)
  const safeStart = startOffset > fileSize ? 0 : Math.max(0, startOffset);

  // Extract only the un-parsed slice — LLM token budget is not wasted on
  // bytes we have already consumed. Disk read is the full file, which is
  // cheap; LLM context is what we are protecting.
  const slice = buffer.subarray(safeStart);
  if (slice.length === 0) {
    return { turns: [], endOffset: safeStart, bytesRead: 0, fileSize, bashCommands: [] };
  }

  const content = slice.toString("utf-8");
  const turns: ConversationTurn[] = [];
  const bashCommands: string[] = [];
  const lines = content.split("\n").filter(Boolean);

  for (const line of lines) {
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }

    const msg = event.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    // Cursor's JSONL puts `role` at the top level; Claude Code nests it
    // inside `message`. Detect by ide param (callers always know which IDE
    // produced the file) and pick the right extraction path. We accept
    // EITHER shape regardless of `ide` as a defensive fallback — older
    // sessions may not have the `ide` field on ClaudeSessionRef.
    const role = (ide === "cursor" ? event.role : msg.role) ?? msg.role ?? event.role;
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
        // Collect raw Bash commands for filesChanged supplementation
        if (name === "Bash" && block.input?.command) {
          bashCommands.push(String(block.input.command));
        }
      }
    }
  }

  return {
    turns,
    bashCommands,
    endOffset: fileSize,
    bytesRead: fileSize - safeStart,
    fileSize,
  };
}

/**
 * Backward-compatible wrapper: parse the whole transcript from offset 0
 * and return only the turns. Used by legacy callers that do not care about
 * resume-audit offsets (e.g. scope-dryrun, single-transcript audit stats).
 */
export function parseTranscript(path: string, ide: IdeKind = "claude-code"): ConversationTurn[] {
  return parseTranscriptFromOffset(path, 0, ide).turns;
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
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
 * Convenience wrapper used by the session auditor. Parses from offset 0
 * (whole file) — used by dry-run and single-audit fallback paths.
 */
export function parseAndRenderTranscript(path: string, ide: IdeKind = "claude-code"): ParsedTranscript {
  const slice = parseTranscriptFromOffset(path, 0, ide);
  const rendered = renderConversation(slice.turns);

  return {
    turns: slice.turns,
    rendered,
    rawSize: slice.fileSize,
    filteredSize: rendered.length,
    userTurns: slice.turns.filter(t => t.role === "user" && t.kind === "text").length,
    assistantTurns: slice.turns.filter(t => t.role === "assistant" && t.kind === "text").length,
    thinkingTurns: slice.turns.filter(t => t.kind === "thinking").length,
    toolUseTurns: slice.turns.filter(t => t.kind === "tool_use").length,
  };
}

/**
 * Parse and render multiple transcripts (for multi-agent sessions), joining
 * them with role labels so the auditor can distinguish which agent said what.
 * Also returns the combined turns list for downstream chunking.
 *
 * Resume-audit optimization: if startOffsets is provided, each ref is parsed
 * starting from its stored byte offset (the position reached on the previous
 * audit of the same Claude session). Returns per-ref end offsets so the
 * caller can persist them after a successful audit. Refs without an entry
 * in startOffsets are parsed from offset 0.
 */
export function parseAndRenderTranscripts(
  refs: Array<{ id: string; transcriptPath: string; role?: string; ide?: IdeKind }>,
  startOffsets?: Record<string, number>,
): {
  rendered: string;
  totalRaw: number;
  totalFiltered: number;
  /** Combined turns across all refs, for chunking in the auditor. */
  allTurns: ConversationTurn[];
  /** Per-ref end offset after this parse — caller persists these on audit success. */
  endOffsets: Record<string, number>;
  /** Per-ref bytes consumed on this call (for observability). */
  bytesRead: Record<string, number>;
  /** Aggregated raw bash commands across all refs. */
  allBashCommands: string[];
} {
  const endOffsets: Record<string, number> = {};
  const bytesRead: Record<string, number> = {};
  if (refs.length === 0) {
    return { rendered: "", totalRaw: 0, totalFiltered: 0, allTurns: [], endOffsets, bytesRead, allBashCommands: [] };
  }

  if (refs.length === 1) {
    const ref = refs[0];
    const start = startOffsets?.[ref.id] ?? 0;
    const slice = parseTranscriptFromOffset(ref.transcriptPath, start, ref.ide ?? "claude-code");
    const rendered = renderConversation(slice.turns);
    endOffsets[ref.id] = slice.endOffset;
    bytesRead[ref.id] = slice.bytesRead;
    return {
      rendered,
      totalRaw: slice.fileSize,
      totalFiltered: rendered.length,
      allTurns: slice.turns,
      endOffsets,
      bytesRead,
      allBashCommands: slice.bashCommands,
    };
  }

  const parts: string[] = [];
  let totalRaw = 0;
  let totalFiltered = 0;
  const allTurns: ConversationTurn[] = [];
  const allBashCommands: string[] = [];
  for (const ref of refs) {
    const start = startOffsets?.[ref.id] ?? 0;
    const slice = parseTranscriptFromOffset(ref.transcriptPath, start, ref.ide ?? "claude-code");
    endOffsets[ref.id] = slice.endOffset;
    bytesRead[ref.id] = slice.bytesRead;
    if (slice.turns.length === 0) {
      totalRaw += slice.fileSize;
      continue;
    }
    const rendered = renderConversation(slice.turns);
    parts.push(`==== AGENT: ${ref.role ?? "main"} (session ${ref.id}) ====`);
    parts.push(rendered);
    parts.push("");
    totalRaw += slice.fileSize;
    totalFiltered += rendered.length;
    allTurns.push(...slice.turns);
    allBashCommands.push(...slice.bashCommands);
  }
  return {
    rendered: parts.join("\n"),
    totalRaw,
    totalFiltered,
    allTurns,
    allBashCommands,
    endOffsets,
    bytesRead,
  };
}
