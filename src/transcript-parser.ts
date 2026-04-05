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
 * Render filtered conversation turns into a compact text format for the LLM.
 * Consecutive tool_use blocks from the assistant are coalesced into one line.
 */
export function renderConversation(turns: ConversationTurn[]): string {
  const lines: string[] = [];
  let currentRole: string | null = null;
  let toolBuffer: string[] = [];

  const flushToolBuffer = () => {
    if (toolBuffer.length > 0) {
      lines.push(`  tools: ${toolBuffer.join(" ")}`);
      toolBuffer = [];
    }
  };

  for (const turn of turns) {
    if (turn.kind === "tool_use") {
      toolBuffer.push(turn.content);
      continue;
    }
    flushToolBuffer();

    if (turn.role !== currentRole) {
      lines.push("");
      currentRole = turn.role;
    }

    if (turn.kind === "thinking") {
      lines.push(`[ASSISTANT thinking] ${turn.content}`);
    } else if (turn.kind === "text") {
      const tag = turn.role === "user" ? "USER" : "ASSISTANT";
      lines.push(`[${tag}] ${turn.content}`);
    }
  }
  flushToolBuffer();

  return lines.join("\n");
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
 */
export function parseAndRenderTranscripts(
  refs: Array<{ id: string; transcriptPath: string; role?: string }>,
): { rendered: string; totalRaw: number; totalFiltered: number } {
  if (refs.length === 0) return { rendered: "", totalRaw: 0, totalFiltered: 0 };
  if (refs.length === 1) {
    const parsed = parseAndRenderTranscript(refs[0].transcriptPath);
    return { rendered: parsed.rendered, totalRaw: parsed.rawSize, totalFiltered: parsed.filteredSize };
  }

  const parts: string[] = [];
  let totalRaw = 0;
  let totalFiltered = 0;
  for (const ref of refs) {
    const parsed = parseAndRenderTranscript(ref.transcriptPath);
    if (parsed.rendered.length === 0) continue;
    parts.push(`==== AGENT: ${ref.role ?? "main"} (session ${ref.id}) ====`);
    parts.push(parsed.rendered);
    parts.push("");
    totalRaw += parsed.rawSize;
    totalFiltered += parsed.filteredSize;
  }
  return { rendered: parts.join("\n"), totalRaw, totalFiltered };
}
