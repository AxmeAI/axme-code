import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  claudeCodeInputAdapter,
  claudeCodeOutputAdapter,
} from "../src/hooks/adapters/claude-code.js";

describe("claudeCodeInputAdapter.parse — round-trip", () => {
  it("maps Claude Code preToolUse stdin → NormalizedHookEvent identically", () => {
    const raw = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x.ts", new_string: "y" },
      session_id: "claude-session-uuid",
      transcript_path: "/home/user/.claude/projects/foo/abc.jsonl",
    };
    const ev = claudeCodeInputAdapter.parse(raw, "preToolUse");
    assert.equal(ev.kind, "preToolUse");
    assert.equal(ev.ide, "claude-code");
    assert.equal(ev.toolName, "Edit");
    assert.deepEqual(ev.toolInput, { file_path: "/tmp/x.ts", new_string: "y" });
    assert.equal(ev.sessionId, "claude-session-uuid");
    assert.equal(ev.transcriptPath, "/home/user/.claude/projects/foo/abc.jsonl");
  });

  it("handles sessionEnd shape (no tool_name)", () => {
    const ev = claudeCodeInputAdapter.parse(
      {
        session_id: "claude-session-uuid",
        transcript_path: "/home/user/.claude/projects/foo/abc.jsonl",
      },
      "sessionEnd",
    );
    assert.equal(ev.kind, "sessionEnd");
    assert.equal(ev.ide, "claude-code");
    assert.equal(ev.sessionId, "claude-session-uuid");
    assert.equal(ev.toolName, undefined);
  });
});

describe("claudeCodeOutputAdapter.emitDeny — regression", () => {
  it("produces JSON byte-identical to current pre-tool-use deny shape (PreToolUse)", () => {
    const reason = "git push --force is denied";
    const result = claudeCodeOutputAdapter.emitDeny(reason, "preToolUse");
    assert.equal(result.exitCode, 0);
    // Exact JSON the old pre-tool-use.ts:67-76 produced:
    const expected = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[AXME Safety] ${reason}`,
      },
    });
    assert.equal(result.stdout, expected);
  });

  it("emits matching hookEventName for postToolUse / sessionEnd kinds", () => {
    const post = claudeCodeOutputAdapter.emitDeny("nope", "postToolUse");
    const parsed = JSON.parse(post.stdout) as { hookSpecificOutput: { hookEventName: string } };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");

    const end = claudeCodeOutputAdapter.emitDeny("nope", "sessionEnd");
    const parsedEnd = JSON.parse(end.stdout) as { hookSpecificOutput: { hookEventName: string } };
    assert.equal(parsedEnd.hookSpecificOutput.hookEventName, "SessionEnd");
  });
});

describe("claudeCodeInputAdapter — defensive parsing", () => {
  it("tolerates non-object stdin", () => {
    const ev = claudeCodeInputAdapter.parse(null, "preToolUse");
    assert.equal(ev.ide, "claude-code");
    assert.equal(ev.toolName, undefined);
    assert.deepEqual(ev.raw, {});
  });
});
