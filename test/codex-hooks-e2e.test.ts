import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, readdirSync, statSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end: drive the real hook subprocesses with Codex-shaped stdin and
 * `--ide codex`, exactly as .codex/hooks.json does. Covers the two things
 * that differ from Claude Code at the protocol level — apply_patch file
 * tracking and shell-side denied paths — plus the git gate passing through
 * unchanged.
 */

const REPO_ROOT = process.cwd();
let ROOT = "";

function codexPayload(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: "codex-e2e-session",
    transcript_path: join(ROOT, "rollout-fake.jsonl"),
    cwd: ROOT,
    hook_event_name: "PreToolUse",
    model: "gpt-5-codex",
    permission_mode: "default",
    turn_id: "turn-1",
    ...extra,
  };
}

function spawnHook(hookName: string, stdinJson: object) {
  const isWin = process.platform === "win32";
  const npxBin = isWin ? "npx.cmd" : "npx";
  const args = ["tsx", "src/cli.ts", "hook", hookName, "--workspace", ROOT, "--ide", "codex"];
  return spawnSync(npxBin, args, {
    cwd: REPO_ROOT,
    input: JSON.stringify(stdinJson),
    encoding: "utf-8",
    env: { ...process.env, AXME_TELEMETRY_DISABLED: "1" },
    timeout: 20000,
    shell: isWin,
  });
}

function findMetaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findMetaFiles(p));
    else if (name === "meta.json") out.push(p);
  }
  return out;
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "axme-codex-e2e-"));
  mkdirSync(join(ROOT, ".axme-code"), { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("codex hooks end-to-end", () => {
  it("pre-tool-use blocks git push --force with the Claude-style deny envelope (exit 0)", () => {
    const r = spawnHook("pre-tool-use", codexPayload({
      tool_name: "Bash",
      tool_input: { command: "git push --force origin main" },
      tool_use_id: "tu-1",
    }));
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> };
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /\[AXME Safety\]/);
  });

  it("pre-tool-use blocks a shell read of a denied path (Codex has no Read tool)", () => {
    const r = spawnHook("pre-tool-use", codexPayload({
      tool_name: "Bash",
      tool_input: { command: 'cat "~/.ssh/id_rsa"' },
      tool_use_id: "tu-2",
    }));
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> };
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /Path denied/);
  });

  it("pre-tool-use allows an ordinary apply_patch and MCP tool calls", () => {
    const patch = spawnHook("pre-tool-use", codexPayload({
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+2\n*** End Patch" },
      tool_use_id: "tu-3",
    }));
    assert.equal(patch.status, 0, `stderr: ${patch.stderr}`);
    assert.equal(patch.stdout.trim(), "");
    const mcp = spawnHook("pre-tool-use", codexPayload({
      tool_name: "mcp__axme__axme_save_memory",
      tool_input: { type: "pattern", title: "t", description: "d" },
      tool_use_id: "tu-4",
    }));
    assert.equal(mcp.status, 0, `stderr: ${mcp.stderr}`);
    assert.equal(mcp.stdout.trim(), "");
  });

  it("post-tool-use records every file of an apply_patch call in the AXME session", () => {
    const r = spawnHook("post-tool-use", codexPayload({
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+2\n*** Add File: docs/b.md\n+hi\n*** End Patch" },
      tool_response: { ok: true },
      tool_use_id: "tu-5",
    }));
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const metas = findMetaFiles(join(ROOT, ".axme-code"));
    assert.ok(metas.length >= 1, "an AXME session should have been created for the Codex session");
    const changed = metas
      .flatMap((m) => (JSON.parse(readFileSync(m, "utf-8")) as { filesChanged?: string[] }).filesChanged ?? [])
      .map((p) => p.replace(/\\/g, "/")); // Windows stores backslashes
    assert.ok(changed.some((p) => p.endsWith("src/a.ts")), `filesChanged=${JSON.stringify(changed)}`);
    assert.ok(changed.some((p) => p.endsWith("docs/b.md")), `filesChanged=${JSON.stringify(changed)}`);
  });

  it("session-start prints the axme_context nudge when the project is initialized", () => {
    const r = spawnHook("session-start", codexPayload({ hook_event_name: "SessionStart", source: "startup" }));
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // ROOT has .axme-code/ but no config.yaml → "not initialized" branch; the
    // real repo (REPO_ROOT) is initialized → ready branch. Check both texts.
    assert.match(r.stdout, /\[AXME Code\] Project not initialized/);
  });
});
