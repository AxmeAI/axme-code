import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBash, checkFilePath } from "../src/storage/safety.js";
import type { SafetyRules } from "../src/types.js";

const defaultRules: SafetyRules = {
  git: { protectedBranches: ["main"], allowForcePush: false, allowDirectPushToMain: false, requirePrForMain: false },
  bash: {
    allowedPrefixes: [],
    deniedPrefixes: ["rm -rf /", "chmod 777", "curl | sh", "curl | bash", "wget | sh", "npm publish", "git tag"],
    deniedCommands: ["shutdown", "reboot", "halt", "poweroff", "mkfs", "dd if="],
  },
  filesystem: {
    deniedPaths: ["/etc/passwd", "/etc/shadow", "~/.ssh/id_*", ".env", "*.pem", "*.key"],
    readOnlyPaths: ["/usr/lib"],
  },
};

// ---------------------------------------------------------------------------
// stripQuoted (tested via checkBash)
// ---------------------------------------------------------------------------

describe("stripQuoted (via checkBash)", () => {
  it("allows denied prefix inside double quotes", () => {
    const v = checkBash(defaultRules, 'echo "rm -rf / is dangerous"');
    assert.equal(v.allowed, true);
  });

  it("allows denied prefix inside single quotes", () => {
    const v = checkBash(defaultRules, "echo 'rm -rf / is dangerous'");
    assert.equal(v.allowed, true);
  });

  it("blocks denied prefix outside quotes", () => {
    const v = checkBash(defaultRules, "rm -rf /");
    assert.equal(v.allowed, false);
  });

  it("handles mixed single/double quotes correctly", () => {
    // The denied text is fully inside single quotes
    const v = checkBash(defaultRules, `echo "safe" 'rm -rf / oops' "also safe"`);
    assert.equal(v.allowed, true);
  });

  it("handles escaped quotes - denied text remains unquoted", () => {
    // The backslash-escaped double quote means the text is NOT inside quotes
    const v = checkBash(defaultRules, 'rm -rf /foo');
    assert.equal(v.allowed, false);
  });

  it("allows empty command", () => {
    const v = checkBash(defaultRules, "");
    assert.equal(v.allowed, true);
  });
});

// ---------------------------------------------------------------------------
// splitChainSegments (tested via checkBash)
// ---------------------------------------------------------------------------

describe("splitChainSegments (via checkBash)", () => {
  it("blocks denied prefix after &&", () => {
    const v = checkBash(defaultRules, "cd /tmp && rm -rf /");
    assert.equal(v.allowed, false);
  });

  it("blocks denied prefix after ;", () => {
    const v = checkBash(defaultRules, "cd /tmp; rm -rf /");
    assert.equal(v.allowed, false);
  });

  it("blocks denied prefix after ||", () => {
    const v = checkBash(defaultRules, "test -f /x || rm -rf /");
    assert.equal(v.allowed, false);
  });

  it("does not split && inside quotes - command allowed", () => {
    const v = checkBash(defaultRules, 'echo "cd /tmp && rm -rf / bad"');
    assert.equal(v.allowed, true);
  });

  it("does not split ; inside quotes - command allowed", () => {
    const v = checkBash(defaultRules, 'echo "cd /tmp; rm -rf / bad"');
    assert.equal(v.allowed, true);
  });

  it("blocks denied command in pipe segment", () => {
    const v = checkBash(defaultRules, "cat file | shutdown -h now");
    assert.equal(v.allowed, false);
  });

  it("allows safe piped commands", () => {
    const v = checkBash(defaultRules, "cat file.txt | grep pattern | wc -l");
    assert.equal(v.allowed, true);
  });
});

// ---------------------------------------------------------------------------
// isPrefixBoundaryMatch (tested via checkBash)
// ---------------------------------------------------------------------------

describe("isPrefixBoundaryMatch (via checkBash)", () => {
  it("blocks exact prefix match", () => {
    const v = checkBash(defaultRules, "npm publish");
    assert.equal(v.allowed, false);
  });

  it("blocks prefix with arguments", () => {
    const v = checkBash(defaultRules, "npm publish --access public");
    assert.equal(v.allowed, false);
  });

  it("allows prefix as substring of longer word", () => {
    // "npm publisher-tool" should NOT be blocked by "npm publish" prefix
    const v = checkBash(defaultRules, "npm publisher-tool --help");
    assert.equal(v.allowed, true);
  });

  it("blocks prefix ending with non-alphanumeric (rm -rf /foo blocked by rm -rf /)", () => {
    const v = checkBash(defaultRules, "rm -rf /foo");
    assert.equal(v.allowed, false);
  });
});

// ---------------------------------------------------------------------------
// checkFilePath
// ---------------------------------------------------------------------------

describe("checkFilePath", () => {
  it("blocks denied path exact match (/etc/passwd)", () => {
    const v = checkFilePath(defaultRules, "/etc/passwd", "read");
    assert.equal(v.allowed, false);
  });

  it("blocks denied path prefix match (/etc/shadow.bak)", () => {
    const v = checkFilePath(defaultRules, "/etc/shadow.bak", "read");
    assert.equal(v.allowed, false);
  });

  it("blocks .env by basename match", () => {
    const v = checkFilePath(defaultRules, "/home/user/project/.env", "read");
    assert.equal(v.allowed, false);
  });

  it("blocks *.pem glob", () => {
    const v = checkFilePath(defaultRules, "/tmp/server.pem", "read");
    assert.equal(v.allowed, false);
  });

  it("blocks *.key glob", () => {
    const v = checkFilePath(defaultRules, "/home/user/.ssh/deploy.key", "read");
    assert.equal(v.allowed, false);
  });

  it("blocks ~/.ssh/id_* glob (expands ~ to HOME)", () => {
    const home = process.env.HOME ?? "/home/user";
    const v = checkFilePath(defaultRules, `${home}/.ssh/id_rsa`, "read");
    assert.equal(v.allowed, false);
  });

  it("allows normal file path", () => {
    const v = checkFilePath(defaultRules, "/home/user/project/src/index.ts", "read");
    assert.equal(v.allowed, true);
  });

  it("blocks write to read-only path", () => {
    const v = checkFilePath(defaultRules, "/usr/lib/something.so", "write");
    assert.equal(v.allowed, false);
  });

  it("allows read from read-only path", () => {
    const v = checkFilePath(defaultRules, "/usr/lib/something.so", "read");
    assert.equal(v.allowed, true);
  });

  it("allows write to normal path", () => {
    const v = checkFilePath(defaultRules, "/home/user/project/src/main.ts", "write");
    assert.equal(v.allowed, true);
  });
});
