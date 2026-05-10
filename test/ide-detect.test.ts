import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseIdeFlag,
  detectIdeFromEnv,
  detectIdeFromHookStdin,
  resolveIde,
} from "../src/utils/ide-detect.js";

describe("parseIdeFlag", () => {
  it("returns 'cursor' for --ide cursor", () => {
    assert.equal(parseIdeFlag(["--ide", "cursor"]), "cursor");
  });

  it("returns 'cursor' for --ide=cursor", () => {
    assert.equal(parseIdeFlag(["--ide=cursor"]), "cursor");
  });

  it("returns 'claude-code' for --ide claude-code", () => {
    assert.equal(parseIdeFlag(["--ide", "claude-code"]), "claude-code");
  });

  it("returns undefined when --ide is absent", () => {
    assert.equal(parseIdeFlag([]), undefined);
    assert.equal(parseIdeFlag(["--workspace", "/tmp/foo"]), undefined);
  });

  it("ignores unknown values", () => {
    assert.equal(parseIdeFlag(["--ide", "windsurf"]), undefined);
    assert.equal(parseIdeFlag(["--ide=copilot"]), undefined);
  });

  it("handles --ide as last argv element with no value", () => {
    assert.equal(parseIdeFlag(["--ide"]), undefined);
  });
});

describe("detectIdeFromEnv", () => {
  it("returns 'cursor' when AXME_IDE=cursor", () => {
    assert.equal(detectIdeFromEnv({ AXME_IDE: "cursor" }), "cursor");
  });

  it("returns 'claude-code' when AXME_IDE=claude-code", () => {
    assert.equal(detectIdeFromEnv({ AXME_IDE: "claude-code" }), "claude-code");
  });

  it("returns undefined when AXME_IDE is absent or unknown", () => {
    assert.equal(detectIdeFromEnv({}), undefined);
    assert.equal(detectIdeFromEnv({ AXME_IDE: "vscode" }), undefined);
  });
});

describe("detectIdeFromHookStdin", () => {
  it("returns 'cursor' when cursor_version is present", () => {
    assert.equal(
      detectIdeFromHookStdin({ cursor_version: "1.7.3", hook_event_name: "preToolUse" }),
      "cursor",
    );
  });

  it("returns 'cursor' when workspace_roots array is present", () => {
    assert.equal(
      detectIdeFromHookStdin({ workspace_roots: ["/tmp/foo"], session_id: "x" }),
      "cursor",
    );
  });

  it("returns undefined for Claude Code shape (only positively identifies Cursor)", () => {
    assert.equal(
      detectIdeFromHookStdin({ tool_name: "Edit", session_id: "abc", transcript_path: "/x" }),
      undefined,
    );
  });

  it("returns undefined for non-object input", () => {
    assert.equal(detectIdeFromHookStdin(null), undefined);
    assert.equal(detectIdeFromHookStdin("string"), undefined);
    assert.equal(detectIdeFromHookStdin(undefined), undefined);
  });
});

describe("resolveIde precedence", () => {
  it("argv flag wins over env and stdin", () => {
    assert.equal(
      resolveIde(["--ide", "claude-code"], { cursor_version: "1.7" }, { AXME_IDE: "cursor" }),
      "claude-code",
    );
  });

  it("env wins over stdin when no argv flag", () => {
    assert.equal(
      resolveIde([], { cursor_version: "1.7" }, { AXME_IDE: "claude-code" }),
      "claude-code",
    );
  });

  it("stdin heuristic wins when no argv and no env", () => {
    assert.equal(resolveIde([], { cursor_version: "1.7" }, {}), "cursor");
  });

  it("defaults to 'claude-code' when nothing matches", () => {
    assert.equal(resolveIde([], undefined, {}), "claude-code");
    assert.equal(resolveIde([], {}, {}), "claude-code");
  });
});
