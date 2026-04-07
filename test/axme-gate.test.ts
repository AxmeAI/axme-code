import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAxmeGate, checkGit } from "../src/storage/safety.js";
import type { SafetyRules } from "../src/storage/safety.js";

const defaultRules: SafetyRules = {
  git: { protectedBranches: ["main", "master"], allowForcePush: false, allowDirectPushToMain: false },
  bash: { deniedPrefixes: [], deniedCommands: [] },
  filesystem: { deniedPaths: [] },
};

describe("parseAxmeGate", () => {
  it("parses valid gate metadata", () => {
    const result = parseAxmeGate('git commit -m "fix" #!axme pr=37 repo=AxmeAI/axme-code');
    assert.deepEqual(result, { pr: "37", repo: "AxmeAI/axme-code" });
  });

  it("parses pr=none", () => {
    const result = parseAxmeGate('git commit -m "init" #!axme pr=none repo=AxmeAI/axme-code');
    assert.deepEqual(result, { pr: "none", repo: "AxmeAI/axme-code" });
  });

  it("returns null for no gate marker", () => {
    assert.equal(parseAxmeGate('git commit -m "fix"'), null);
  });

  it("returns null for incomplete gate (missing repo)", () => {
    assert.equal(parseAxmeGate('git commit -m "fix" #!axme pr=37'), null);
  });

  it("returns null for incomplete gate (missing pr)", () => {
    assert.equal(parseAxmeGate('git commit -m "fix" #!axme repo=AxmeAI/axme-code'), null);
  });

  it("works with git push", () => {
    const result = parseAxmeGate('git push -u origin feat/xxx #!axme pr=42 repo=AxmeAI/axme-cli');
    assert.deepEqual(result, { pr: "42", repo: "AxmeAI/axme-cli" });
  });

  it("works with git -C path", () => {
    const result = parseAxmeGate('git -C /path/to/repo commit -m "msg" #!axme pr=10 repo=AxmeAI/test');
    assert.deepEqual(result, { pr: "10", repo: "AxmeAI/test" });
  });
});

describe("checkGit with axme gate", () => {
  it("blocks git commit without #!axme gate", () => {
    const v = checkGit(defaultRules, 'git commit -m "test"');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("#!axme"));
    assert.ok(v.reason!.includes("BLOCKED"));
  });

  it("blocks git push without #!axme gate", () => {
    const v = checkGit(defaultRules, "git push origin feat/xxx");
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("#!axme"));
  });

  it("allows git commit with pr=none", () => {
    const v = checkGit(defaultRules, 'git commit -m "init" #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, true);
  });

  it("allows git push with pr=none", () => {
    const v = checkGit(defaultRules, 'git push -u origin feat/xxx #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, true);
  });

  it("blocks invalid PR number", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme pr=abc repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("Invalid PR number"));
  });

  it("does not require gate on git add", () => {
    const v = checkGit(defaultRules, "git add src/file.ts");
    assert.equal(v.allowed, true);
  });

  it("does not require gate on git status", () => {
    const v = checkGit(defaultRules, "git status");
    assert.equal(v.allowed, true);
  });

  it("does not require gate on git branch", () => {
    const v = checkGit(defaultRules, "git branch --show-current");
    assert.equal(v.allowed, true);
  });

  it("does not require gate on git diff", () => {
    const v = checkGit(defaultRules, "git diff --stat");
    assert.equal(v.allowed, true);
  });

  it("does not require gate on git log", () => {
    const v = checkGit(defaultRules, "git log --oneline -5");
    assert.equal(v.allowed, true);
  });

  it("skips gate check when skipMergedCheck is true", () => {
    const v = checkGit(defaultRules, 'git commit -m "x"', undefined, true);
    assert.equal(v.allowed, true);
  });

  it("still blocks force push even with valid gate", () => {
    const v = checkGit(defaultRules, 'git push --force origin main #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("Force push"));
  });

  it("still blocks direct push to main even with valid gate", () => {
    const v = checkGit(defaultRules, 'git push origin main #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("Direct push to main"));
  });

  it("works with git -C prefix", () => {
    const v = checkGit(defaultRules, 'git -C /home/user/repo commit -m "fix" #!axme pr=none repo=AxmeAI/test');
    assert.equal(v.allowed, true);
  });
});
