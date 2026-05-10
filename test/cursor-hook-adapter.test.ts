import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cursorInputAdapter, cursorOutputAdapter } from "../src/hooks/adapters/cursor.js";

describe("cursorInputAdapter.parse — preToolUse", () => {
  it("maps Cursor preToolUse stdin → NormalizedHookEvent", () => {
    const raw = {
      cursor_version: "1.7.3",
      hook_event_name: "preToolUse",
      conversation_id: "conv-abc-123",
      generation_id: "gen-xyz-789",
      model: "composer-2",
      workspace_roots: ["/tmp/cursor-smoke"],
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/cursor-smoke/foo.ts", new_string: "x" },
      tool_use_id: "tu-001",
      cwd: "/tmp/cursor-smoke",
      transcript_path: null,
    };
    const ev = cursorInputAdapter.parse(raw, "preToolUse");
    assert.equal(ev.kind, "preToolUse");
    assert.equal(ev.ide, "cursor");
    assert.equal(ev.toolName, "Edit");
    assert.deepEqual(ev.toolInput, { file_path: "/tmp/cursor-smoke/foo.ts", new_string: "x" });
    assert.equal(ev.sessionId, "conv-abc-123");
    assert.equal(ev.transcriptPath, null);
    assert.equal(ev.raw.cursor_version, "1.7.3");
  });

  it("preserves transcript_path string when present", () => {
    const ev = cursorInputAdapter.parse(
      {
        cursor_version: "1.7",
        conversation_id: "c1",
        tool_name: "Read",
        tool_input: { file_path: "/x" },
        transcript_path: "/Users/me/.cursor/transcripts/t.jsonl",
      },
      "preToolUse",
    );
    assert.equal(ev.transcriptPath, "/Users/me/.cursor/transcripts/t.jsonl");
  });
});

describe("cursorInputAdapter.parse — sessionEnd", () => {
  it("uses session_id (not conversation_id) for sessionEnd", () => {
    const ev = cursorInputAdapter.parse(
      {
        cursor_version: "1.7",
        conversation_id: "conv-a",
        session_id: "sdk-session-b",
        reason: "user_close",
        duration_ms: 12345,
        is_background_agent: false,
        final_status: "completed",
      },
      "sessionEnd",
    );
    assert.equal(ev.kind, "sessionEnd");
    assert.equal(ev.ide, "cursor");
    assert.equal(ev.sessionId, "sdk-session-b");
    assert.equal(ev.reason, "user_close");
  });

  it("falls back to conversation_id when session_id absent", () => {
    const ev = cursorInputAdapter.parse(
      { cursor_version: "1.7", conversation_id: "conv-a", reason: "completed" },
      "sessionEnd",
    );
    assert.equal(ev.sessionId, "conv-a");
  });
});

describe("cursorOutputAdapter.emitDeny", () => {
  it("emits flat permission/user_message JSON and exit code 2", () => {
    const result = cursorOutputAdapter.emitDeny("force-push to main is blocked", "preToolUse");
    assert.equal(result.exitCode, 2);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed.permission, "deny");
    assert.match(parsed.user_message as string, /\[AXME Safety\]/);
    assert.match(parsed.user_message as string, /force-push/);
    assert.equal(parsed.user_message, parsed.agent_message);
  });

  it("does NOT use Claude-style hookSpecificOutput envelope", () => {
    const result = cursorOutputAdapter.emitDeny("blocked", "preToolUse");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed.hookSpecificOutput, undefined);
  });
});

describe("cursorInputAdapter — defensive parsing", () => {
  it("tolerates non-object stdin", () => {
    const ev = cursorInputAdapter.parse(null, "preToolUse");
    assert.equal(ev.ide, "cursor");
    assert.equal(ev.kind, "preToolUse");
    assert.equal(ev.toolName, undefined);
    assert.deepEqual(ev.raw, {});
  });

  it("tolerates missing fields", () => {
    const ev = cursorInputAdapter.parse({ cursor_version: "1.7" }, "postToolUse");
    assert.equal(ev.toolName, undefined);
    assert.equal(ev.toolInput, undefined);
    assert.equal(ev.sessionId, undefined);
  });
});
