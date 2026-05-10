import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  parseTranscriptFromOffset,
  parseTranscript,
  renderConversation,
  renderConversationChunk,
  splitTurnsIntoChunks,
  parseAndRenderTranscript,
  parseAndRenderTranscripts,
} from "../src/transcript-parser.js";
import type { ConversationTurn } from "../src/transcript-parser.js";

const ROOT = "/tmp/axme-transcript-parser-test";

function jsonl(...events: object[]): string {
  return events.map(e => JSON.stringify(e)).join("\n") + "\n";
}

function userText(text: string): object {
  return { message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantText(text: string): object {
  return { message: { role: "assistant", content: [{ type: "text", text }] } };
}

function assistantThinking(thinking: string): object {
  return { message: { role: "assistant", content: [{ type: "thinking", thinking }] } };
}

function assistantToolUse(name: string, input: Record<string, any>): object {
  return { message: { role: "assistant", content: [{ type: "tool_use", name, input }] } };
}

function toolResult(content: string): object {
  return { message: { role: "user", content: [{ type: "tool_result", content }] } };
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseTranscriptFromOffset - basic parsing
// ---------------------------------------------------------------------------

describe("parseTranscriptFromOffset", () => {
  it("returns empty for non-existent file", () => {
    const result = parseTranscriptFromOffset("/tmp/axme-no-such-file.jsonl");
    assert.equal(result.turns.length, 0);
    assert.equal(result.endOffset, 0);
    assert.equal(result.bytesRead, 0);
    assert.equal(result.fileSize, 0);
  });

  it("parses user text messages", () => {
    const path = join(ROOT, "user.jsonl");
    writeFileSync(path, jsonl(userText("hello world")));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].role, "user");
    assert.equal(result.turns[0].kind, "text");
    assert.equal(result.turns[0].content, "hello world");
  });

  it("filters IDE notifications from user messages", () => {
    const path = join(ROOT, "ide.jsonl");
    writeFileSync(path, jsonl(
      userText("<ide_opened_file>some file</ide_opened_file>"),
      userText("<ide_selection>some code</ide_selection>"),
      userText("<system-reminder>some reminder</system-reminder>"),
      userText("<command-name>some command</command-name>"),
      userText("<command-message>some message</command-message>"),
      userText("Caveat: some caveat"),
      userText("real user message"),
    ));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].content, "real user message");
  });

  it("filters short assistant text (< 80 chars)", () => {
    const path = join(ROOT, "short.jsonl");
    const short = "Short msg";  // < 80 chars
    const long = "A".repeat(80);  // exactly 80 chars
    writeFileSync(path, jsonl(assistantText(short), assistantText(long)));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].content, long);
  });

  it("keeps all assistant thinking blocks", () => {
    const path = join(ROOT, "thinking.jsonl");
    writeFileSync(path, jsonl(
      assistantThinking("short thought"),
      assistantThinking("longer reasoning about the problem"),
    ));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns.length, 2);
    assert.ok(result.turns.every(t => t.kind === "thinking"));
  });

  it("parses assistant tool_use blocks as compact form", () => {
    const path = join(ROOT, "tool-use.jsonl");
    writeFileSync(path, jsonl(
      assistantToolUse("Read", { file_path: "/src/main.ts" }),
      assistantToolUse("Bash", { command: "npm test" }),
      assistantToolUse("Grep", { pattern: "TODO", path: "/src" }),
    ));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns.length, 3);
    assert.equal(result.turns[0].content, "[Read: /src/main.ts]");
    assert.equal(result.turns[1].content, "[Bash: npm test]");
    assert.equal(result.turns[2].content, '[Grep: "TODO" in /src]');
  });

  it("extracts bash commands into bashCommands array", () => {
    const path = join(ROOT, "bash-cmds.jsonl");
    writeFileSync(path, jsonl(
      assistantToolUse("Bash", { command: "npm test" }),
      assistantToolUse("Bash", { command: "git status" }),
      assistantToolUse("Read", { file_path: "/foo" }),
    ));
    const result = parseTranscriptFromOffset(path);
    assert.deepEqual(result.bashCommands, ["npm test", "git status"]);
  });

  it("skips invalid JSON lines gracefully", () => {
    const path = join(ROOT, "bad-json.jsonl");
    writeFileSync(path, "not json\n" + JSON.stringify(userText("valid")) + "\n{broken\n");
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].content, "valid");
  });

  it("skips messages without content array", () => {
    const path = join(ROOT, "no-content.jsonl");
    writeFileSync(path, jsonl(
      { message: { role: "user" } },
      { message: { role: "user", content: "string not array" } },
      { noMessage: true },
      userText("real"),
    ));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns.length, 1);
  });

  it("skips image blocks", () => {
    const path = join(ROOT, "image.jsonl");
    writeFileSync(path, jsonl(
      { message: { role: "assistant", content: [{ type: "image", data: "base64..." }] } },
      userText("after image"),
    ));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].content, "after image");
  });
});

// ---------------------------------------------------------------------------
// parseTranscriptFromOffset - offset handling
// ---------------------------------------------------------------------------

describe("parseTranscriptFromOffset offset", () => {
  it("resumes from byte offset", () => {
    const path = join(ROOT, "offset.jsonl");
    const line1 = JSON.stringify(userText("first")) + "\n";
    const line2 = JSON.stringify(userText("second")) + "\n";
    writeFileSync(path, line1 + line2);

    const result = parseTranscriptFromOffset(path, Buffer.byteLength(line1));
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].content, "second");
    assert.equal(result.bytesRead, Buffer.byteLength(line2));
  });

  it("returns empty when offset equals file size", () => {
    const path = join(ROOT, "at-end.jsonl");
    const content = JSON.stringify(userText("msg")) + "\n";
    writeFileSync(path, content);
    const fileSize = Buffer.byteLength(content);
    const result = parseTranscriptFromOffset(path, fileSize);
    assert.equal(result.turns.length, 0);
    assert.equal(result.bytesRead, 0);
    assert.equal(result.endOffset, fileSize);
  });

  it("resets to 0 when offset exceeds file size (file rotated)", () => {
    const path = join(ROOT, "rotated.jsonl");
    writeFileSync(path, jsonl(userText("after rotation")));
    const result = parseTranscriptFromOffset(path, 999999);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].content, "after rotation");
  });

  it("endOffset equals file size after full parse", () => {
    const path = join(ROOT, "full.jsonl");
    const content = jsonl(userText("a"), userText("b"));
    writeFileSync(path, content);
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.endOffset, Buffer.byteLength(content));
    assert.equal(result.fileSize, Buffer.byteLength(content));
  });
});

// ---------------------------------------------------------------------------
// Tool input shortening
// ---------------------------------------------------------------------------

describe("tool input shortening", () => {
  it("Edit tool shows file_path", () => {
    const path = join(ROOT, "edit.jsonl");
    writeFileSync(path, jsonl(assistantToolUse("Edit", { file_path: "/src/foo.ts", old_string: "a", new_string: "b" })));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns[0].content, "[Edit: /src/foo.ts]");
  });

  it("Write tool shows file_path", () => {
    const path = join(ROOT, "write.jsonl");
    writeFileSync(path, jsonl(assistantToolUse("Write", { file_path: "/new.ts", content: "x".repeat(1000) })));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns[0].content, "[Write: /new.ts]");
  });

  it("Glob tool shows pattern", () => {
    const path = join(ROOT, "glob.jsonl");
    writeFileSync(path, jsonl(assistantToolUse("Glob", { pattern: "**/*.ts" })));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns[0].content, "[Glob: **/*.ts]");
  });

  it("WebFetch shows url", () => {
    const path = join(ROOT, "web.jsonl");
    writeFileSync(path, jsonl(assistantToolUse("WebFetch", { url: "https://example.com" })));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns[0].content, "[WebFetch: https://example.com]");
  });

  it("WebSearch shows query", () => {
    const path = join(ROOT, "search.jsonl");
    writeFileSync(path, jsonl(assistantToolUse("WebSearch", { query: "axme code" })));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns[0].content, "[WebSearch: axme code]");
  });

  it("TodoWrite shows todo count", () => {
    const path = join(ROOT, "todo.jsonl");
    writeFileSync(path, jsonl(assistantToolUse("TodoWrite", { todos: [1, 2, 3] })));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns[0].content, "[TodoWrite: 3 todos]");
  });

  it("Bash command is truncated at 200 chars", () => {
    const path = join(ROOT, "bash-long.jsonl");
    const longCmd = "x".repeat(300);
    writeFileSync(path, jsonl(assistantToolUse("Bash", { command: longCmd })));
    const result = parseTranscriptFromOffset(path);
    assert.ok(result.turns[0].content.includes("x".repeat(200)));
    assert.ok(!result.turns[0].content.includes("x".repeat(201)));
  });

  it("unknown tool shows first 3 key=value pairs", () => {
    const path = join(ROOT, "custom.jsonl");
    writeFileSync(path, jsonl(assistantToolUse("CustomTool", { alpha: "one", beta: "two", gamma: "three", delta: "four" })));
    const result = parseTranscriptFromOffset(path);
    const content = result.turns[0].content;
    assert.ok(content.includes("alpha=one"));
    assert.ok(content.includes("beta=two"));
    assert.ok(content.includes("gamma=three"));
    assert.ok(!content.includes("delta=four"));
  });

  it("tool_use with no input shows just the name", () => {
    const path = join(ROOT, "no-input.jsonl");
    writeFileSync(path, jsonl(assistantToolUse("SomeTool", {})));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns[0].content, "[SomeTool]");
  });
});

// ---------------------------------------------------------------------------
// parseTranscript (legacy wrapper)
// ---------------------------------------------------------------------------

describe("parseTranscript", () => {
  it("returns turns array from full file", () => {
    const path = join(ROOT, "legacy.jsonl");
    writeFileSync(path, jsonl(userText("msg1"), userText("msg2")));
    const turns = parseTranscript(path);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].content, "msg1");
    assert.equal(turns[1].content, "msg2");
  });
});

// ---------------------------------------------------------------------------
// renderConversation
// ---------------------------------------------------------------------------

describe("renderConversation", () => {
  it("renders user message in XML tags", () => {
    const turns: ConversationTurn[] = [{ role: "user", kind: "text", content: "hello" }];
    const xml = renderConversation(turns);
    assert.ok(xml.includes("<session_transcript>"));
    assert.ok(xml.includes("</session_transcript>"));
    assert.ok(xml.includes("<user_message>hello</user_message>"));
  });

  it("renders assistant message in XML tags", () => {
    const turns: ConversationTurn[] = [{ role: "assistant", kind: "text", content: "response" }];
    const xml = renderConversation(turns);
    assert.ok(xml.includes("<assistant_message>response</assistant_message>"));
  });

  it("renders thinking in XML tags", () => {
    const turns: ConversationTurn[] = [{ role: "assistant", kind: "thinking", content: "reasoning" }];
    const xml = renderConversation(turns);
    assert.ok(xml.includes("<assistant_thinking>reasoning</assistant_thinking>"));
  });

  it("groups consecutive tool_use into assistant_tool_calls", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", kind: "tool_use", content: "[Read: /a]" },
      { role: "assistant", kind: "tool_use", content: "[Bash: ls]" },
    ];
    const xml = renderConversation(turns);
    assert.ok(xml.includes("<assistant_tool_calls>"));
    assert.ok(xml.includes("[Read: /a] [Bash: ls]"));
    assert.ok(xml.includes("</assistant_tool_calls>"));
  });

  it("flushes tool buffer when non-tool turn appears", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", kind: "tool_use", content: "[Read: /a]" },
      { role: "user", kind: "text", content: "question" },
      { role: "assistant", kind: "tool_use", content: "[Bash: ls]" },
    ];
    const xml = renderConversation(turns);
    // Two separate tool_calls blocks
    const matches = xml.match(/<assistant_tool_calls>/g);
    assert.equal(matches?.length, 2);
  });

  it("escapes XML special characters", () => {
    const turns: ConversationTurn[] = [{ role: "user", kind: "text", content: '<script>alert("xss")&</script>' }];
    const xml = renderConversation(turns);
    assert.ok(xml.includes("&lt;script&gt;"));
    assert.ok(xml.includes("&amp;"));
    assert.ok(xml.includes("&quot;"));
    assert.ok(!xml.includes("<script>"));
  });

  it("empty turns produce just wrapper tags", () => {
    const xml = renderConversation([]);
    assert.ok(xml.includes("<session_transcript>"));
    assert.ok(xml.includes("</session_transcript>"));
    const lines = xml.split("\n").filter(l => l.trim());
    assert.equal(lines.length, 2);
  });
});

// ---------------------------------------------------------------------------
// renderConversationChunk
// ---------------------------------------------------------------------------

describe("renderConversationChunk", () => {
  it("uses session_transcript for single chunk", () => {
    const turns: ConversationTurn[] = [{ role: "user", kind: "text", content: "hi" }];
    const xml = renderConversationChunk(turns, { index: 1, total: 1 });
    assert.ok(xml.includes("<session_transcript>"));
    assert.ok(xml.includes("</session_transcript>"));
  });

  it("uses session_transcript_chunk with index/total for multi-chunk", () => {
    const turns: ConversationTurn[] = [{ role: "user", kind: "text", content: "hi" }];
    const xml = renderConversationChunk(turns, { index: 2, total: 5 });
    assert.ok(xml.includes('<session_transcript_chunk index="2" total="5">'));
    assert.ok(xml.includes("</session_transcript_chunk>"));
    assert.ok(!xml.includes("<session_transcript>"));
  });
});

// ---------------------------------------------------------------------------
// splitTurnsIntoChunks
// ---------------------------------------------------------------------------

describe("splitTurnsIntoChunks", () => {
  it("returns empty array for empty turns", () => {
    assert.deepEqual(splitTurnsIntoChunks([], 1000), []);
  });

  it("returns single chunk when everything fits", () => {
    const turns: ConversationTurn[] = [
      { role: "user", kind: "text", content: "short" },
      { role: "assistant", kind: "text", content: "also short" },
    ];
    const chunks = splitTurnsIntoChunks(turns, 10000);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 2);
  });

  it("splits into multiple chunks when content exceeds limit", () => {
    const turns: ConversationTurn[] = [];
    for (let i = 0; i < 20; i++) {
      turns.push({ role: "user", kind: "text", content: "X".repeat(500) });
    }
    // Each turn is ~560 chars (500 + tag overhead). With 2000 char limit,
    // about 3 turns per chunk.
    const chunks = splitTurnsIntoChunks(turns, 2000);
    assert.ok(chunks.length > 1);
    // All turns are accounted for
    const total = chunks.reduce((s, c) => s + c.length, 0);
    assert.equal(total, 20);
  });

  it("oversized single turn gets its own chunk", () => {
    const turns: ConversationTurn[] = [
      { role: "user", kind: "text", content: "small" },
      { role: "assistant", kind: "thinking", content: "X".repeat(5000) },
      { role: "user", kind: "text", content: "small2" },
    ];
    const chunks = splitTurnsIntoChunks(turns, 1000);
    // The oversized turn should be isolated
    assert.ok(chunks.length >= 2);
    const oversizedChunk = chunks.find(c => c.length === 1 && c[0].content.length > 4000);
    assert.ok(oversizedChunk);
  });

  it("respects turn boundaries - never splits mid-turn", () => {
    const turns: ConversationTurn[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push({ role: "user", kind: "text", content: `message ${i}` });
    }
    const chunks = splitTurnsIntoChunks(turns, 500);
    for (const chunk of chunks) {
      for (const turn of chunk) {
        assert.ok(turn.content.startsWith("message"));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// parseAndRenderTranscript
// ---------------------------------------------------------------------------

describe("parseAndRenderTranscript", () => {
  it("returns full stats for a transcript", () => {
    const path = join(ROOT, "full-render.jsonl");
    const longText = "A".repeat(100);
    writeFileSync(path, jsonl(
      userText("user question"),
      assistantText(longText),
      assistantThinking("thought"),
      assistantToolUse("Bash", { command: "ls" }),
    ));
    const result = parseAndRenderTranscript(path);
    assert.equal(result.userTurns, 1);
    assert.equal(result.assistantTurns, 1);
    assert.equal(result.thinkingTurns, 1);
    assert.equal(result.toolUseTurns, 1);
    assert.ok(result.rendered.includes("<session_transcript>"));
    assert.ok(result.rawSize > 0);
    assert.ok(result.filteredSize > 0);
    assert.ok(result.filteredSize <= result.rawSize);
  });
});

// ---------------------------------------------------------------------------
// parseAndRenderTranscripts (multi-ref)
// ---------------------------------------------------------------------------

describe("parseAndRenderTranscripts", () => {
  it("returns empty for no refs", () => {
    const result = parseAndRenderTranscripts([]);
    assert.equal(result.rendered, "");
    assert.equal(result.totalRaw, 0);
    assert.deepEqual(result.allTurns, []);
  });

  it("handles single ref same as renderConversation", () => {
    const path = join(ROOT, "single-ref.jsonl");
    writeFileSync(path, jsonl(userText("msg")));
    const result = parseAndRenderTranscripts([{ id: "s1", transcriptPath: path }]);
    assert.ok(result.rendered.includes("<session_transcript>"));
    assert.ok(result.rendered.includes("<user_message>msg</user_message>"));
    assert.equal(result.allTurns.length, 1);
    assert.equal(result.endOffsets["s1"], result.totalRaw);
  });

  it("handles multiple refs with role labels", () => {
    const path1 = join(ROOT, "multi1.jsonl");
    const path2 = join(ROOT, "multi2.jsonl");
    writeFileSync(path1, jsonl(userText("from main")));
    writeFileSync(path2, jsonl(userText("from reviewer")));
    const result = parseAndRenderTranscripts([
      { id: "s1", transcriptPath: path1, role: "main" },
      { id: "s2", transcriptPath: path2, role: "reviewer" },
    ]);
    assert.ok(result.rendered.includes("AGENT: main (session s1)"));
    assert.ok(result.rendered.includes("AGENT: reviewer (session s2)"));
    assert.equal(result.allTurns.length, 2);
    assert.ok(result.endOffsets["s1"] > 0);
    assert.ok(result.endOffsets["s2"] > 0);
  });

  it("respects startOffsets for resume", () => {
    const path = join(ROOT, "resume.jsonl");
    const line1 = JSON.stringify(userText("first")) + "\n";
    const line2 = JSON.stringify(userText("second")) + "\n";
    writeFileSync(path, line1 + line2);
    const offset1 = Buffer.byteLength(line1);

    const result = parseAndRenderTranscripts(
      [{ id: "s1", transcriptPath: path }],
      { s1: offset1 },
    );
    assert.equal(result.allTurns.length, 1);
    assert.equal(result.allTurns[0].content, "second");
    assert.equal(result.bytesRead["s1"], Buffer.byteLength(line2));
  });

  it("aggregates bash commands from all refs", () => {
    const path1 = join(ROOT, "bash1.jsonl");
    const path2 = join(ROOT, "bash2.jsonl");
    writeFileSync(path1, jsonl(assistantToolUse("Bash", { command: "cmd1" })));
    writeFileSync(path2, jsonl(assistantToolUse("Bash", { command: "cmd2" })));
    const result = parseAndRenderTranscripts([
      { id: "s1", transcriptPath: path1 },
      { id: "s2", transcriptPath: path2 },
    ]);
    assert.deepEqual(result.allBashCommands, ["cmd1", "cmd2"]);
  });

  it("skips empty transcript refs gracefully", () => {
    const path1 = join(ROOT, "empty-ref.jsonl");
    const path2 = join(ROOT, "has-data.jsonl");
    writeFileSync(path1, "");
    writeFileSync(path2, jsonl(userText("data")));
    const result = parseAndRenderTranscripts([
      { id: "s1", transcriptPath: path1 },
      { id: "s2", transcriptPath: path2 },
    ]);
    assert.equal(result.allTurns.length, 1);
    assert.ok(!result.rendered.includes("AGENT: undefined (session s1)"));
  });
});

// ---------------------------------------------------------------------------
// Multibyte character handling
// ---------------------------------------------------------------------------

describe("multibyte characters", () => {
  it("handles UTF-8 multibyte correctly with offsets", () => {
    const path = join(ROOT, "utf8.jsonl");
    const line1 = JSON.stringify(userText("hello")) + "\n";
    const line2 = JSON.stringify(userText("privet")) + "\n";
    writeFileSync(path, line1 + line2);

    const firstResult = parseTranscriptFromOffset(path);
    assert.equal(firstResult.turns.length, 2);

    // Resume from byte offset of first parse should yield nothing
    const resumed = parseTranscriptFromOffset(path, firstResult.endOffset);
    assert.equal(resumed.turns.length, 0);
  });

  it("escapes XML entities in multibyte content", () => {
    const turns: ConversationTurn[] = [
      { role: "user", kind: "text", content: "test <tag> & 'quotes' \"double\"" },
    ];
    const xml = renderConversation(turns);
    assert.ok(xml.includes("&lt;tag&gt;"));
    assert.ok(xml.includes("&amp;"));
    assert.ok(xml.includes("&apos;"));
    assert.ok(xml.includes("&quot;"));
  });
});

// ---------------------------------------------------------------------------
// Mixed content blocks in single message
// ---------------------------------------------------------------------------

describe("mixed content blocks", () => {
  it("extracts multiple block types from one message", () => {
    const path = join(ROOT, "mixed.jsonl");
    writeFileSync(path, jsonl({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "analyzing..." },
          { type: "text", text: "A".repeat(100) },
          { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
        ],
      },
    }));
    const result = parseTranscriptFromOffset(path);
    assert.equal(result.turns.length, 3);
    assert.equal(result.turns[0].kind, "thinking");
    assert.equal(result.turns[1].kind, "text");
    assert.equal(result.turns[2].kind, "tool_use");
  });
});

// ---------------------------------------------------------------------------
// Cursor JSONL transcript shape (top-level role)
// ---------------------------------------------------------------------------

describe("Cursor JSONL transcript parsing", () => {
  function cursorUser(text: string): object {
    return { role: "user", message: { content: [{ type: "text", text }] } };
  }
  function cursorAssistant(text: string): object {
    return { role: "assistant", message: { content: [{ type: "text", text }] } };
  }

  it("parses Cursor format with role at top level (ide='cursor')", () => {
    const path = join(ROOT, "cursor.jsonl");
    writeFileSync(path, jsonl(
      cursorUser("Hello, please refactor the auth module"),
      cursorAssistant("A".repeat(120) + " — done."),
    ));
    const result = parseTranscriptFromOffset(path, 0, "cursor");
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].role, "user");
    assert.equal(result.turns[0].kind, "text");
    assert.match(result.turns[0].content, /refactor the auth/);
    assert.equal(result.turns[1].role, "assistant");
    assert.equal(result.turns[1].kind, "text");
  });

  it("Cursor format works even without ide param (defensive top-level role fallback)", () => {
    // ClaudeSessionRef.ide is optional for backward compat. If a Cursor
    // transcript is parsed with the default ide="claude-code", the parser's
    // defensive fallback (`event.role ?? msg.role`) should still pick up
    // the top-level role.
    const path = join(ROOT, "cursor-no-ide.jsonl");
    writeFileSync(path, jsonl(cursorAssistant("B".repeat(120))));
    const result = parseTranscriptFromOffset(path);  // default ide
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].role, "assistant");
  });

  it("text-only Cursor transcript yields zero tool_use turns", () => {
    // Real Cursor transcripts contain only text blocks (verified empirically
    // 2026-05-10). Confirm parser doesn't synthesize fake tool_use turns.
    const path = join(ROOT, "cursor-text-only.jsonl");
    writeFileSync(path, jsonl(
      cursorUser("Q1"),
      cursorAssistant("A".repeat(100)),
      cursorUser("Q2"),
      cursorAssistant("B".repeat(100)),
    ));
    const result = parseTranscriptFromOffset(path, 0, "cursor");
    assert.equal(result.turns.filter(t => t.kind === "tool_use").length, 0);
    assert.equal(result.turns.filter(t => t.kind === "thinking").length, 0);
    assert.equal(result.turns.filter(t => t.kind === "text").length, 4);
  });

  it("Claude Code format still parses correctly with ide='claude-code' (regression)", () => {
    const path = join(ROOT, "claude.jsonl");
    writeFileSync(path, jsonl(
      { message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { message: { role: "assistant", content: [{ type: "text", text: "B".repeat(100) }] } },
    ));
    const result = parseTranscriptFromOffset(path, 0, "claude-code");
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].role, "user");
    assert.equal(result.turns[1].role, "assistant");
  });
});
