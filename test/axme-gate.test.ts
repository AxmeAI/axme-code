import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAxmeGate, checkGit } from "../src/storage/safety.js";
import type { SafetyRules } from "../src/storage/safety.js";

const defaultRules: SafetyRules = {
  git: { protectedBranches: ["main", "master"], allowForcePush: false, allowDirectPushToMain: false },
  bash: { deniedPrefixes: [], deniedCommands: [] },
  filesystem: { deniedPaths: [] },
};

// ===== parseAxmeGate =====

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

  it("parses with reversed key order (repo before pr)", () => {
    const result = parseAxmeGate('git commit -m "x" #!axme repo=AxmeAI/axme-code pr=55');
    assert.deepEqual(result, { pr: "55", repo: "AxmeAI/axme-code" });
  });

  it("parses large PR numbers", () => {
    const result = parseAxmeGate('git commit -m "x" #!axme pr=9999 repo=AxmeAI/axme-code');
    assert.deepEqual(result, { pr: "9999", repo: "AxmeAI/axme-code" });
  });

  it("returns null for empty #!axme marker", () => {
    assert.equal(parseAxmeGate('git commit -m "fix" #!axme'), null);
  });

  it("returns null for #!axme with random text", () => {
    assert.equal(parseAxmeGate('git commit -m "fix" #!axme something=else'), null);
  });

  it("does not match plain # axme (no !)", () => {
    assert.equal(parseAxmeGate('git commit -m "fix" # axme pr=37 repo=X/Y'), null);
  });

  it("does not match #!AXME (case sensitive)", () => {
    assert.equal(parseAxmeGate('git commit -m "fix" #!AXME pr=37 repo=X/Y'), null);
  });

  it("uses LAST #!axme when commit message also contains #!axme", () => {
    const cmd = 'git commit -m "refactor: remove code after #!axme gate change" #!axme pr=none repo=AxmeAI/axme-code';
    const result = parseAxmeGate(cmd);
    assert.deepEqual(result, { pr: "none", repo: "AxmeAI/axme-code" });
  });

  it("uses last #!axme in HEREDOC commit with #!axme in body", () => {
    const cmd = `git commit -m "$(cat <<'EOF'\ndead code after #!axme gate\nEOF\n)" #!axme pr=42 repo=AxmeAI/test`;
    const result = parseAxmeGate(cmd);
    assert.deepEqual(result, { pr: "42", repo: "AxmeAI/test" });
  });

  // --- B-008 regression: greedy \S+ used to swallow the closing quote ---

  it("strips trailing closing quote when marker is inside -m \"...\" string", () => {
    // This is the B-008 reproducer: marker placed INSIDE the quoted message.
    const cmd = 'git commit -m "fix: blah #!axme pr=6 repo=AxmeAI/axme-blog"';
    const result = parseAxmeGate(cmd);
    assert.deepEqual(result, { pr: "6", repo: "AxmeAI/axme-blog" });
  });

  it("strips trailing single quote", () => {
    const cmd = "git commit -m 'fix #!axme pr=6 repo=AxmeAI/axme-blog'";
    const result = parseAxmeGate(cmd);
    assert.deepEqual(result, { pr: "6", repo: "AxmeAI/axme-blog" });
  });

  it("strips trailing backtick", () => {
    const cmd = "git commit -m `fix #!axme pr=6 repo=AxmeAI/axme-blog`";
    const result = parseAxmeGate(cmd);
    assert.deepEqual(result, { pr: "6", repo: "AxmeAI/axme-blog" });
  });

  it("strips trailing punctuation like ) and ,", () => {
    const cmd1 = 'git commit -m "$(echo fix #!axme pr=6 repo=AxmeAI/axme-blog)"';
    assert.deepEqual(parseAxmeGate(cmd1), { pr: "6", repo: "AxmeAI/axme-blog" });
    const cmd2 = 'git commit -m "fix #!axme pr=6 repo=AxmeAI/axme-blog,"';
    assert.deepEqual(parseAxmeGate(cmd2), { pr: "6", repo: "AxmeAI/axme-blog" });
  });

  it("returns null when stripping leaves an empty value", () => {
    // pr=" — value is just a quote, after strip nothing left.
    const cmd = 'git commit -m "x #!axme pr=" repo=AxmeAI/x"';
    assert.equal(parseAxmeGate(cmd), null);
  });
});

// ===== checkGit - gate enforcement =====

describe("checkGit - gate blocks commit/push without #!axme", () => {
  it("blocks git commit without gate", () => {
    const v = checkGit(defaultRules, 'git commit -m "test"');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("#!axme"));
    assert.ok(v.reason!.includes("BLOCKED"));
  });

  it("blocks git push without gate", () => {
    const v = checkGit(defaultRules, "git push origin feat/xxx");
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("#!axme"));
  });

  it("blocks git push -u without gate", () => {
    const v = checkGit(defaultRules, "git push -u origin feat/xxx");
    assert.equal(v.allowed, false);
  });

  it("blocks git commit --amend without gate", () => {
    const v = checkGit(defaultRules, "git commit --amend --no-edit");
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("#!axme"));
  });

  it("blocks bare git push without gate", () => {
    const v = checkGit(defaultRules, "git push");
    assert.equal(v.allowed, false);
  });

  it("block message includes format instruction", () => {
    const v = checkGit(defaultRules, 'git commit -m "x"');
    assert.ok(v.reason!.includes("pr=<PR_NUMBER|none>"));
    assert.ok(v.reason!.includes("repo=<OWNER/REPO>"));
  });
});

// ===== checkGit - gate allows valid metadata =====

describe("checkGit - gate allows valid metadata", () => {
  it("allows git commit with pr=none", () => {
    const v = checkGit(defaultRules, 'git commit -m "init" #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, true);
  });

  it("allows git push with pr=none", () => {
    const v = checkGit(defaultRules, 'git push -u origin feat/xxx #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, true);
  });

  it("allows git commit --amend with pr=none", () => {
    const v = checkGit(defaultRules, 'git commit --amend --no-edit #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, true);
  });

  it("allows bare git push with pr=none", () => {
    const v = checkGit(defaultRules, 'git push #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, true);
  });

  it("allows with reversed key order", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme repo=AxmeAI/axme-code pr=none');
    assert.equal(v.allowed, true);
  });
});

// ===== checkGit - gate validation =====

describe("checkGit - gate validation errors", () => {
  it("blocks invalid PR number", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme pr=abc repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("Invalid PR number"));
  });

  it("blocks negative PR number", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme pr=-1 repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
  });

  it("blocks zero PR number", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme pr=0 repo=AxmeAI/axme-code');
    // 0 is technically parseable as a number but not a valid PR
    // isPrMerged will be called - it will fail on gh and block (fail-closed)
    // This tests the gh error path
    assert.equal(v.allowed, false);
  });

  it("blocks incomplete gate (only pr)", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme pr=37');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("#!axme"));
  });

  it("blocks incomplete gate (only repo)", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
  });
});

// ===== checkGit - commands that DON'T need gate =====

describe("checkGit - commands not requiring gate", () => {
  const safeCommands = [
    "git add src/file.ts",
    "git add .",
    "git add -A",
    "git status",
    "git status -sb",
    "git branch --show-current",
    "git branch -a",
    "git diff --stat",
    "git diff HEAD",
    "git log --oneline -5",
    "git log --graph",
    "git fetch origin",
    "git fetch --all",
    "git pull --ff-only",
    "git checkout main",
    "git checkout -b feat/new",
    "git switch main",
    "git stash",
    "git stash pop",
    "git merge --no-ff feat/x",
    "git rebase main",
    // "git tag v1.0.0" - now blocked by D-028 (tested separately)
    "git remote -v",
    "git rev-parse HEAD",
    "git cherry-pick abc123",
    "git rm file.txt",
    "git mv old.ts new.ts",
    "git show HEAD",
    "git describe --tags",
    "git clean -n",
  ];

  for (const cmd of safeCommands) {
    it(`allows: ${cmd}`, () => {
      const v = checkGit(defaultRules, cmd);
      assert.equal(v.allowed, true, `${cmd} should be allowed without gate`);
    });
  }
});

// ===== checkGit - other safety checks still work with gate =====

describe("checkGit - other safety checks with gate present", () => {
  it("still blocks force push -f even with valid gate", () => {
    const v = checkGit(defaultRules, 'git push -f origin feat/x #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("Force push"));
  });

  it("still blocks force push --force even with valid gate", () => {
    const v = checkGit(defaultRules, 'git push --force origin feat/x #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("Force push"));
  });

  it("still blocks --force-with-lease even with valid gate", () => {
    const v = checkGit(defaultRules, 'git push --force-with-lease origin feat/x #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
  });

  it("still blocks +refspec force push with gate", () => {
    const v = checkGit(defaultRules, 'git push origin +feat/x #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
  });

  it("still blocks direct push to main with gate", () => {
    const v = checkGit(defaultRules, 'git push origin main #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("Direct push to main"));
  });

  it("still blocks direct push to master with gate", () => {
    const v = checkGit(defaultRules, 'git push origin master #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
  });

  it("still blocks HEAD:main refspec with gate", () => {
    const v = checkGit(defaultRules, 'git push origin HEAD:main #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
  });

  it("still blocks git reset --hard with gate", () => {
    const v = checkGit(defaultRules, 'git reset --hard HEAD #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("reset --hard"));
  });

  it("does not false-positive on branch names containing -f", () => {
    const v = checkGit(defaultRules, 'git push origin feat/my-fixes #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, true);
  });

  it("does not false-positive on branch names containing main", () => {
    const v = checkGit(defaultRules, 'git push origin feat/main-refactor #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, true);
  });
});

// ===== checkGit - git -C prefix =====

describe("checkGit - git -C prefix", () => {
  it("allows commit with -C and gate", () => {
    const v = checkGit(defaultRules, 'git -C /home/user/repo commit -m "fix" #!axme pr=none repo=AxmeAI/test');
    assert.equal(v.allowed, true);
  });

  it("blocks commit with -C but no gate", () => {
    const v = checkGit(defaultRules, 'git -C /home/user/repo commit -m "fix"');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("#!axme"));
  });

  it("allows push with -C and gate", () => {
    const v = checkGit(defaultRules, 'git -C /repo push origin feat/x #!axme pr=5 repo=AxmeAI/test');
    // PR 5 check would call gh - which will fail in test env -> fail-closed
    assert.equal(v.allowed, false); // gh not available -> blocked
  });

  it("blocks force push with -C even with gate", () => {
    const v = checkGit(defaultRules, 'git -C /repo push --force origin feat/x #!axme pr=none repo=AxmeAI/test');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("Force push"));
  });
});

// ===== checkGit - HEREDOC commit messages =====

describe("checkGit - HEREDOC and complex commit messages", () => {
  it("handles commit with HEREDOC-style message and gate", () => {
    const cmd = `git commit -m "$(cat <<'EOF'\nMultiline message\nEOF\n)" #!axme pr=none repo=AxmeAI/axme-code`;
    const v = checkGit(defaultRules, cmd);
    assert.equal(v.allowed, true);
  });

  it("handles commit message containing special characters", () => {
    const v = checkGit(defaultRules, 'git commit -m "fix: handle \\"edge\\" case" #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, true);
  });

  it("handles commit message with backticks", () => {
    const v = checkGit(defaultRules, 'git commit -m "fix: use `async`" #!axme pr=none repo=AxmeAI/axme-code');
    assert.equal(v.allowed, true);
  });
});

// ===== checkGit - real PR verification (live gh call) =====

describe("checkGit - live PR verification", () => {
  it("blocks commit referencing a merged PR (PR #36 is merged)", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme pr=36 repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("merged") || v.reason!.includes("BLOCKED") || v.reason!.includes("Cannot verify"));
  });

  it("blocks commit referencing another merged PR (PR #38 is merged)", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme pr=38 repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
  });

  it("blocks commit referencing nonexistent PR (fail-closed on gh error)", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme pr=999999 repo=AxmeAI/axme-code');
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("Cannot verify") || v.reason!.includes("gh CLI error"));
  });

  it("blocks commit referencing nonexistent repo (fail-closed on gh error)", () => {
    const v = checkGit(defaultRules, 'git commit -m "x" #!axme pr=1 repo=nonexistent/repo-xyz');
    assert.equal(v.allowed, false);
  });
});

// ===== skipMergedCheck flag =====

describe("checkGit - skipMergedCheck flag", () => {
  it("skips gate check entirely when flag is true", () => {
    const v = checkGit(defaultRules, 'git commit -m "x"', undefined, true);
    assert.equal(v.allowed, true);
  });

  it("still enforces force push even with skip flag", () => {
    const v = checkGit(defaultRules, "git push --force origin feat/x", undefined, true);
    assert.equal(v.allowed, false);
  });

  it("still enforces direct-to-main even with skip flag", () => {
    const v = checkGit(defaultRules, "git push origin main", undefined, true);
    assert.equal(v.allowed, false);
  });

  it("still blocks git tag even with skip flag", () => {
    const v = checkGit(defaultRules, "git tag v1.0.0", undefined, true);
    assert.equal(v.allowed, false);
  });
});

// ===== checkGit - git tag blocked =====

describe("checkGit - git tag blocked (D-028)", () => {
  it("blocks git tag v1.0.0", () => {
    const v = checkGit(defaultRules, "git tag v1.0.0");
    assert.equal(v.allowed, false);
    assert.ok(v.reason!.includes("tag"));
    assert.ok(v.reason!.includes("publish"));
  });

  it("blocks git tag -a v1.0.0", () => {
    const v = checkGit(defaultRules, 'git tag -a v1.0.0 -m "release"');
    assert.equal(v.allowed, false);
  });

  it("blocks git tag with message", () => {
    const v = checkGit(defaultRules, 'git tag -m "Release v2" v2.0.0');
    assert.equal(v.allowed, false);
  });

  it("blocks git tag --delete (still a tag operation)", () => {
    const v = checkGit(defaultRules, "git tag --delete v1.0.0");
    assert.equal(v.allowed, false);
  });

  it("blocks git tag -l (list) is also blocked", () => {
    // Even listing is blocked via checkGit since it starts with "git tag"
    // This is conservative - agent can use gh CLI to view releases instead
    const v = checkGit(defaultRules, "git tag -l");
    assert.equal(v.allowed, false);
  });

  it("blocks git -C path tag", () => {
    const v = checkGit(defaultRules, "git -C /repo tag v1.0.0");
    assert.equal(v.allowed, false);
  });
});
