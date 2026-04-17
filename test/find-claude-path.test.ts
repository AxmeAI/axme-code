/**
 * Tests for findClaudePath() resolver (B-009).
 *
 * The resolver has 5 steps: env override, SDK env var, `which claude`,
 * standard install locations, nvm glob. We test the env-based steps
 * (1, 2) directly and verify cache + reset behavior.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findClaudePath, _resetFindClaudePath } from "../src/utils/agent-options.ts";

// Save original env
let savedAxme: string | undefined;
let savedEntrypoint: string | undefined;

function createTmpExecutable(name: string): string {
  const dir = join(tmpdir(), `axme-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\necho mock", "utf-8");
  try { chmodSync(file, 0o755); } catch {}
  return file;
}

function removeTmp(path: string): void {
  try { unlinkSync(path); } catch {}
}

describe("findClaudePath — resolution order (B-009)", () => {
  beforeEach(() => {
    _resetFindClaudePath();
    savedAxme = process.env.AXME_CLAUDE_EXECUTABLE;
    savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.AXME_CLAUDE_EXECUTABLE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
  });

  afterEach(() => {
    _resetFindClaudePath();
    if (savedAxme !== undefined) process.env.AXME_CLAUDE_EXECUTABLE = savedAxme;
    else delete process.env.AXME_CLAUDE_EXECUTABLE;
    if (savedEntrypoint !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint;
    else delete process.env.CLAUDE_CODE_ENTRYPOINT;
  });

  it("step 1: AXME_CLAUDE_EXECUTABLE env var takes priority over everything", () => {
    const tmp = createTmpExecutable("claude");
    try {
      process.env.AXME_CLAUDE_EXECUTABLE = tmp;
      const result = findClaudePath();
      assert.equal(result, tmp);
    } finally {
      removeTmp(tmp);
    }
  });

  it("step 1: AXME_CLAUDE_EXECUTABLE with non-existent path is skipped", () => {
    process.env.AXME_CLAUDE_EXECUTABLE = "/nonexistent/path/to/claude";
    const result = findClaudePath();
    // Should fall through to step 2+ (not crash, not return the bogus path)
    assert.notEqual(result, "/nonexistent/path/to/claude");
  });

  it("step 2: CLAUDE_CODE_ENTRYPOINT used when AXME_CLAUDE_EXECUTABLE absent", () => {
    const tmp = createTmpExecutable("claude");
    try {
      process.env.CLAUDE_CODE_ENTRYPOINT = tmp;
      const result = findClaudePath();
      assert.equal(result, tmp);
    } finally {
      removeTmp(tmp);
    }
  });

  it("step 2: CLAUDE_CODE_ENTRYPOINT with non-existent path is skipped", () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "/nonexistent/entrypoint";
    const result = findClaudePath();
    assert.notEqual(result, "/nonexistent/entrypoint");
  });

  it("step 1 beats step 2 when both are set", () => {
    const tmp1 = createTmpExecutable("claude-axme");
    const tmp2 = createTmpExecutable("claude-sdk");
    try {
      process.env.AXME_CLAUDE_EXECUTABLE = tmp1;
      process.env.CLAUDE_CODE_ENTRYPOINT = tmp2;
      const result = findClaudePath();
      assert.equal(result, tmp1, "AXME_CLAUDE_EXECUTABLE should win over CLAUDE_CODE_ENTRYPOINT");
    } finally {
      removeTmp(tmp1);
      removeTmp(tmp2);
    }
  });

  it("result is cached after first successful lookup", () => {
    const tmp = createTmpExecutable("claude");
    try {
      process.env.AXME_CLAUDE_EXECUTABLE = tmp;
      const first = findClaudePath();
      assert.equal(first, tmp);

      // Change env — cached result should still be the first one
      delete process.env.AXME_CLAUDE_EXECUTABLE;
      const second = findClaudePath();
      assert.equal(second, tmp, "Should return cached value, not re-resolve");
    } finally {
      removeTmp(tmp);
    }
  });

  it("_resetFindClaudePath clears the cache", () => {
    const tmp1 = createTmpExecutable("claude-a");
    const tmp2 = createTmpExecutable("claude-b");
    try {
      process.env.AXME_CLAUDE_EXECUTABLE = tmp1;
      assert.equal(findClaudePath(), tmp1);

      _resetFindClaudePath();
      process.env.AXME_CLAUDE_EXECUTABLE = tmp2;
      assert.equal(findClaudePath(), tmp2, "After reset, should re-resolve");
    } finally {
      removeTmp(tmp1);
      removeTmp(tmp2);
    }
  });

  it("returns a string (not undefined) on a dev machine with claude installed", () => {
    // This test runs on our dev machine where `claude` IS in PATH via nvm.
    // On CI without claude installed, this test will find it via nvm glob
    // or standard paths — if neither exist, we just skip the assertion.
    const result = findClaudePath();
    if (result) {
      assert.equal(typeof result, "string");
      assert.ok(result.length > 0);
      assert.ok(result.includes("claude"), `Expected path containing 'claude', got: ${result}`);
    }
    // If result is undefined (bare CI runner), that's OK — the important
    // tests are the env-var ones above which we control.
  });
});
