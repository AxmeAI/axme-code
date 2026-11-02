import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codexInputAdapter, codexOutputAdapter, extractPatchPaths } from "../src/hooks/adapters/codex.js";
import { claudeCodeOutputAdapter } from "../src/hooks/adapters/claude-code.js";

const BASE = {
  session_id: "019a1b2c-codex-session",
  transcript_path: "/home/me/.codex/sessions/2026/11/02/rollout-2026-11-02T10-00-00-019a1b2c.jsonl",
  cwd: "/tmp/codex-smoke",
  hook_event_name: "PreToolUse",
  model: "gpt-5-codex",
  permission_mode: "default",
  turn_id: "turn-1",
};

const PATCH = `*** Begin Patch
*** Update File: src/a.ts
@@
-const a = 1;
+const a = 2;
*** Add File: docs/new.md
+# hello
*** Delete File: old/junk.txt
*** Update File: src/a.ts
@@
-x
+y
*** Update File: /abs/elsewhere.ts
@@
-1
+2
*** End Patch`;

describe("codexInputAdapter.parse — Bash", () => {
  it("passes Bash through unchanged (Claude-Code-shaped payload)", () => {
    const ev = codexInputAdapter.parse(
      { ...BASE, tool_name: "Bash", tool_input: { command: "git push --force origin main" }, tool_use_id: "tu-1" },
      "preToolUse",
    );
    assert.equal(ev.kind, "preToolUse");
    assert.equal(ev.ide, "codex");
    assert.equal(ev.toolName, "Bash");
    assert.deepEqual(ev.toolInput, { command: "git push --force origin main" });
    assert.equal(ev.sessionId, BASE.session_id);
    assert.equal(ev.transcriptPath, BASE.transcript_path);
    assert.equal(ev.filePaths, undefined);
  });
});

describe("codexInputAdapter.parse — apply_patch", () => {
  it("normalizes apply_patch to Edit and lists every touched file, resolved against cwd", () => {
    const ev = codexInputAdapter.parse(
      { ...BASE, tool_name: "apply_patch", tool_input: { command: PATCH } },
      "postToolUse",
    );
    assert.equal(ev.toolName, "Edit");
    assert.deepEqual(ev.filePaths, [
      "/tmp/codex-smoke/src/a.ts",
      "/tmp/codex-smoke/docs/new.md",
      "/tmp/codex-smoke/old/junk.txt",
      "/abs/elsewhere.ts",
    ]);
    // Raw input is preserved for anyone who needs the patch text.
    assert.equal((ev.toolInput as { command: string }).command, PATCH);
  });

  it("accepts the custom-tool `input` field as a fallback for the patch text", () => {
    const ev = codexInputAdapter.parse(
      { ...BASE, tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Add File: x.txt\n+1\n*** End Patch" } },
      "preToolUse",
    );
    assert.equal(ev.toolName, "Edit");
    assert.deepEqual(ev.filePaths, ["/tmp/codex-smoke/x.txt"]);
  });

  it("yields an empty path list (not a crash) when the patch text is missing", () => {
    const ev = codexInputAdapter.parse({ ...BASE, tool_name: "apply_patch", tool_input: {} }, "preToolUse");
    assert.equal(ev.toolName, "Edit");
    assert.deepEqual(ev.filePaths, []);
  });
});

describe("extractPatchPaths", () => {
  it("handles Move to headers and CRLF line endings", () => {
    const patch = "*** Begin Patch\r\n*** Update File: a.txt\r\n*** Move to: b.txt\r\n*** End Patch\r\n";
    assert.deepEqual(extractPatchPaths(patch, "/w"), ["/w/a.txt", "/w/b.txt"]);
  });

  it("returns relative paths as written when cwd is unknown", () => {
    assert.deepEqual(extractPatchPaths("*** Add File: rel/x.ts\n", undefined), ["rel/x.ts"]);
  });

  it("ignores body lines that merely look like headers", () => {
    const patch = "*** Begin Patch\n*** Update File: a.txt\n+*** Update File: not-a-header.txt\n*** End Patch";
    assert.deepEqual(extractPatchPaths(patch, "/w"), ["/w/a.txt"]);
  });
});

describe("codexInputAdapter.parse — sessionEnd", () => {
  it("keys the session by session_id and keeps the reason", () => {
    const ev = codexInputAdapter.parse(
      { session_id: "s-9", transcript_path: null, cwd: "/tmp/x", hook_event_name: "SessionEnd", reason: "other" },
      "sessionEnd",
    );
    assert.equal(ev.kind, "sessionEnd");
    assert.equal(ev.sessionId, "s-9");
    assert.equal(ev.transcriptPath, null);
    assert.equal(ev.reason, "other");
  });
});

describe("codexOutputAdapter.emitDeny", () => {
  it("is the Claude Code envelope: hookSpecificOutput.permissionDecision=deny, exit 0", () => {
    const result = codexOutputAdapter.emitDeny("force-push to main is blocked", "preToolUse");
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, string> };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /\[AXME Safety\] force-push/);
    assert.deepEqual(result, claudeCodeOutputAdapter.emitDeny("force-push to main is blocked", "preToolUse"));
  });
});

describe("codexInputAdapter — defensive parsing", () => {
  it("tolerates non-object stdin", () => {
    const ev = codexInputAdapter.parse(null, "preToolUse");
    assert.equal(ev.ide, "codex");
    assert.equal(ev.toolName, undefined);
    assert.deepEqual(ev.raw, {});
  });

  it("tolerates missing fields", () => {
    const ev = codexInputAdapter.parse({ hook_event_name: "PostToolUse" }, "postToolUse");
    assert.equal(ev.toolName, undefined);
    assert.equal(ev.toolInput, undefined);
    assert.equal(ev.sessionId, undefined);
    assert.equal(ev.transcriptPath, undefined);
  });
});
