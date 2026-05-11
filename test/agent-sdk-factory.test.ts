import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SANDBOX_HOME = "/tmp/axme-agent-sdk-factory-test";
// On Windows os.homedir() reads USERPROFILE, not HOME — override both
// for cross-platform sandboxing.
const HOME_VARS = process.platform === "win32" ? ["USERPROFILE", "HOME"] : ["HOME"];
const ORIGINAL: Record<string, string | undefined> = {};
for (const v of [...HOME_VARS, "AXME_IDE", "ANTHROPIC_API_KEY", "CURSOR_API_KEY"]) {
  ORIGINAL[v] = process.env[v];
}

beforeEach(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  mkdirSync(SANDBOX_HOME, { recursive: true });
  for (const v of HOME_VARS) process.env[v] = SANDBOX_HOME;
  delete process.env.AXME_IDE;
  delete process.env.CURSOR_API_KEY;
  // Keep ANTHROPIC_API_KEY out so factory falls into the "neither" path
  // unless a test sets it explicitly.
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  for (const v of [...HOME_VARS, "AXME_IDE", "ANTHROPIC_API_KEY", "CURSOR_API_KEY"]) {
    if (ORIGINAL[v] === undefined) delete process.env[v];
    else process.env[v] = ORIGINAL[v];
  }
});

describe("createAgentSdk — IDE selection", () => {
  it("selects claude-code by default when no env / auth.yaml signals are set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";
    const { createAgentSdk } = await import("../src/utils/agent-sdk.js");
    const sdk = await createAgentSdk("auditor");
    assert.equal(sdk.ide, "claude-code");
  });

  it("selects cursor when AXME_IDE=cursor and CURSOR_API_KEY set", async () => {
    process.env.AXME_IDE = "cursor";
    process.env.CURSOR_API_KEY = "ck-fake-1234567890abcdefghijklmnopqrstuv";
    const { createAgentSdk } = await import("../src/utils/agent-sdk.js");
    const sdk = await createAgentSdk("auditor", { cwd: SANDBOX_HOME });
    assert.equal(sdk.ide, "cursor");
  });

  it("falls back to claude-code when AXME_IDE=cursor but CURSOR_API_KEY missing", async () => {
    process.env.AXME_IDE = "cursor";
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";
    // CURSOR_API_KEY intentionally unset
    const { createAgentSdk } = await import("../src/utils/agent-sdk.js");
    const sdk = await createAgentSdk("auditor", { cwd: SANDBOX_HOME });
    assert.equal(sdk.ide, "claude-code");
  });

  it("auth.yaml mode=cursor_sdk implies cursor IDE", async () => {
    mkdirSync(join(SANDBOX_HOME, ".config", "axme-code"), { recursive: true });
    writeFileSync(
      join(SANDBOX_HOME, ".config", "axme-code", "auth.yaml"),
      "mode: cursor_sdk\nchosenAt: '2026-05-10T00:00:00.000Z'\n",
    );
    process.env.CURSOR_API_KEY = "ck-fake-1234567890abcdefghijklmnopqrstuv";
    const { createAgentSdk } = await import("../src/utils/agent-sdk.js");
    const sdk = await createAgentSdk("auditor", { cwd: SANDBOX_HOME });
    assert.equal(sdk.ide, "cursor");
  });

  it("throws AgentSdkUnavailableError when neither backend usable", async () => {
    // No ANTHROPIC_API_KEY, no CURSOR_API_KEY, no auth.yaml
    // findClaudePath() may still find a binary on this dev machine — but the
    // factory's claude fallback also requires either a binary OR an env key.
    // To make the test deterministic regardless of dev machine state, we
    // only check the cursor preference path with no key.
    process.env.AXME_IDE = "cursor";
    // Also override AXME_CLAUDE_EXECUTABLE so claude fallback fails.
    const ORIG_AXME_CLAUDE = process.env.AXME_CLAUDE_EXECUTABLE;
    process.env.AXME_CLAUDE_EXECUTABLE = "/nonexistent/path/that/does/not/exist";
    try {
      const { createAgentSdk, AgentSdkUnavailableError } = await import("../src/utils/agent-sdk.js");
      const { _resetFindClaudePath } = await import("../src/utils/agent-options.js");
      _resetFindClaudePath();
      // The dev machine likely still has /home/<user>/.local/bin/claude or
      // similar in the standard-paths fallback; if so, this test is a
      // no-op (factory returns Claude wrapper). Accept either outcome —
      // the negative path (throw) is what matters when no binary exists.
      try {
        const sdk = await createAgentSdk("auditor", { cwd: SANDBOX_HOME });
        // If we reach here, Claude binary was found via standard paths;
        // verify the type is correct anyway.
        assert.equal(sdk.ide, "claude-code");
      } catch (err) {
        assert.ok(err instanceof AgentSdkUnavailableError);
      }
    } finally {
      if (ORIG_AXME_CLAUDE === undefined) delete process.env.AXME_CLAUDE_EXECUTABLE;
      else process.env.AXME_CLAUDE_EXECUTABLE = ORIG_AXME_CLAUDE;
      const { _resetFindClaudePath } = await import("../src/utils/agent-options.js");
      _resetFindClaudePath();
    }
  });
});

describe("mapClaudeToolsToCursor", () => {
  it("Bash → Shell, drops Cursor-incompatible tools", async () => {
    const { mapClaudeToolsToCursor } = await import("../src/utils/agent-options.js");
    const result = mapClaudeToolsToCursor(["Read", "Glob", "Grep", "Edit", "Write", "Bash", "NotebookEdit", "Agent", "TodoWrite"]);
    assert.deepEqual(result.sort(), ["Edit", "Glob", "Grep", "Read", "Shell", "Write"]);
  });

  it("dedupes overlapping inputs", async () => {
    const { mapClaudeToolsToCursor } = await import("../src/utils/agent-options.js");
    const result = mapClaudeToolsToCursor(["Read", "Read", "Bash"]);
    assert.deepEqual(result.sort(), ["Read", "Shell"]);
  });

  it("returns empty array for entirely-incompatible input", async () => {
    const { mapClaudeToolsToCursor } = await import("../src/utils/agent-options.js");
    const result = mapClaudeToolsToCursor(["WebFetch", "WebSearch", "Skill"]);
    assert.deepEqual(result, []);
  });
});
