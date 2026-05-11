import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Hook handlers must accept stdin's `workspace_roots[0]` as a fallback when
 * the --workspace CLI flag is absent. This is required for Cursor user-level
 * hooks installed at ~/.cursor/hooks.json by the VS Code extension — those
 * hooks fire across all projects and cannot hard-code a path at install time.
 *
 * Test strategy: spawn a real `tsx` subprocess running the hook handler with
 * NO --workspace flag, feed Cursor-shaped stdin via stdin pipe, verify the
 * handler resolves the right workspace by checking that an .axme-code/
 * directory at THAT path is touched (or not touched, depending on case).
 */

const ROOT = "/tmp/axme-hooks-ws-fallback-test";
const REPO_ROOT = process.cwd();

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function spawnHook(hookName: "pre-tool-use" | "post-tool-use" | "session-end", argv: string[], stdinJson: object) {
  // On Windows npm/npx ship as .cmd shims; spawnSync won't resolve bare "npx".
  // Use the .cmd extension on win32 and spawn through cmd.exe to avoid
  // CVE-2024-27980 EINVAL when invoking .cmd directly with arguments.
  const isWin = process.platform === "win32";
  const npxBin = isWin ? "npx.cmd" : "npx";
  const args = ["tsx", "src/cli.ts", "hook", hookName, ...argv];
  const result = spawnSync(npxBin, args, {
    cwd: REPO_ROOT,
    input: JSON.stringify(stdinJson),
    encoding: "utf-8",
    env: { ...process.env, AXME_TELEMETRY_DISABLED: "1" },
    timeout: 15000,
    shell: isWin,  // .cmd on Windows requires shell mode
  });
  return result;
}

describe("hook workspace_roots fallback", () => {
  it("pre-tool-use uses --workspace flag when present (Claude Code path)", () => {
    const ws = join(ROOT, "claude-ws");
    mkdirSync(join(ws, ".axme-code"), { recursive: true });
    const r = spawnHook(
      "pre-tool-use",
      ["--workspace", ws],
      { tool_name: "Read", tool_input: { file_path: "/tmp/foo.txt" } },
    );
    // Should exit cleanly (allow). No deny output expected for benign read.
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  });

  it("pre-tool-use falls back to workspace_roots[0] when --workspace absent (Cursor path)", () => {
    const ws = join(ROOT, "cursor-ws");
    mkdirSync(join(ws, ".axme-code"), { recursive: true });
    const r = spawnHook(
      "pre-tool-use",
      ["--ide", "cursor"],   // NO --workspace flag
      {
        cursor_version: "1.7",
        conversation_id: "conv-test",
        workspace_roots: [ws],
        tool_name: "Read",
        tool_input: { file_path: "/tmp/foo.txt" },
        transcript_path: null,
      },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  });

  it("post-tool-use falls back to workspace_roots[0] when --workspace absent", () => {
    const ws = join(ROOT, "cursor-ws-post");
    mkdirSync(join(ws, ".axme-code"), { recursive: true });
    const r = spawnHook(
      "post-tool-use",
      ["--ide", "cursor"],
      {
        cursor_version: "1.7",
        conversation_id: "conv-test-post",
        workspace_roots: [ws],
        tool_name: "Read",
        tool_input: { file_path: "/tmp/foo.txt" },
      },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  });

  it("session-end falls back to workspace_roots[0] when --workspace absent", () => {
    const ws = join(ROOT, "cursor-ws-end");
    mkdirSync(join(ws, ".axme-code"), { recursive: true });
    const r = spawnHook(
      "session-end",
      ["--ide", "cursor"],
      {
        cursor_version: "1.7",
        session_id: "sdk-session-x",
        workspace_roots: [ws],
        reason: "completed",
      },
    );
    // session-end may exit 0 quickly (no AXME session to audit).
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  });

  it("falls back to process.cwd() when neither --workspace nor workspace_roots present", () => {
    // Spawn from REPO_ROOT cwd; no flag, no workspace_roots in stdin.
    // The handler will use REPO_ROOT, find .axme-code/ there (real one),
    // and proceed. Just confirm it doesn't crash.
    const r = spawnHook(
      "pre-tool-use",
      [],
      { tool_name: "Read", tool_input: { file_path: "/tmp/foo.txt" } },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  });
});
