import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  writeCursorMcpJson,
  writeCursorHooksJson,
  writeCursorRulesMdc,
} from "../src/setup/cursor-writers.js";

const ROOT = "/tmp/axme-cursor-writers-test";

function fakeBuildHookCommand(hookName: string, projectPath: string): string {
  return `"/bin/node" "/usr/local/bin/axme-code" hook ${hookName} --workspace "${projectPath}"`;
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("writeCursorMcpJson", () => {
  it("creates .cursor/mcp.json with axme entry when missing", () => {
    writeCursorMcpJson(ROOT);
    const path = join(ROOT, ".cursor", "mcp.json");
    assert.ok(existsSync(path));
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    assert.deepEqual(cfg.mcpServers.axme, { command: "axme-code", args: ["serve"] });
  });

  it("merges into existing file without dropping unrelated mcpServers", () => {
    mkdirSync(join(ROOT, ".cursor"), { recursive: true });
    writeFileSync(
      join(ROOT, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-mcp" } } }),
    );
    writeCursorMcpJson(ROOT);
    const cfg = JSON.parse(readFileSync(join(ROOT, ".cursor", "mcp.json"), "utf-8"));
    assert.deepEqual(cfg.mcpServers.other, { command: "other-mcp" });
    assert.deepEqual(cfg.mcpServers.axme, { command: "axme-code", args: ["serve"] });
  });

  it("is idempotent on re-run", () => {
    writeCursorMcpJson(ROOT);
    writeCursorMcpJson(ROOT);
    const cfg = JSON.parse(readFileSync(join(ROOT, ".cursor", "mcp.json"), "utf-8"));
    assert.equal(Object.keys(cfg.mcpServers).length, 1);
  });
});

describe("writeCursorHooksJson", () => {
  it("creates version:1 file with three hook arrays + --ide cursor flag", () => {
    writeCursorHooksJson(ROOT, fakeBuildHookCommand);
    const path = join(ROOT, ".cursor", "hooks.json");
    assert.ok(existsSync(path));
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(cfg.version, 1);
    for (const kind of ["preToolUse", "postToolUse", "sessionEnd"]) {
      const arr = cfg.hooks[kind];
      assert.ok(Array.isArray(arr) && arr.length === 1, `${kind} should have one entry`);
      assert.match(arr[0].command, /--ide cursor/);
      assert.match(arr[0].command, /axme-code/);
      assert.equal(arr[0].type, "command");
      assert.ok(typeof arr[0].timeout === "number");
    }
  });

  it("dedups axme entries on re-run, preserves user entries", () => {
    mkdirSync(join(ROOT, ".cursor"), { recursive: true });
    writeFileSync(
      join(ROOT, ".cursor", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [
            { command: "echo user-hook", type: "command" },
            { command: "axme-code hook pre-tool-use --workspace OLD --ide cursor", type: "command" },
          ],
          postToolUse: [],
          sessionEnd: [],
        },
      }),
    );
    writeCursorHooksJson(ROOT, fakeBuildHookCommand);
    const cfg = JSON.parse(readFileSync(join(ROOT, ".cursor", "hooks.json"), "utf-8"));
    const pre = cfg.hooks.preToolUse;
    // user-hook preserved + 1 fresh axme entry (old axme entry removed)
    assert.equal(pre.length, 2, `expected 2 entries, got ${JSON.stringify(pre)}`);
    assert.equal(pre[0].command, "echo user-hook");
    assert.match(pre[1].command, /axme-code/);
    assert.match(pre[1].command, /--ide cursor/);
    assert.ok(!pre[1].command.includes("OLD"), "old axme entry should be replaced");
  });

  it("re-running multiple times does not duplicate axme entries", () => {
    writeCursorHooksJson(ROOT, fakeBuildHookCommand);
    writeCursorHooksJson(ROOT, fakeBuildHookCommand);
    writeCursorHooksJson(ROOT, fakeBuildHookCommand);
    const cfg = JSON.parse(readFileSync(join(ROOT, ".cursor", "hooks.json"), "utf-8"));
    for (const kind of ["preToolUse", "postToolUse", "sessionEnd"]) {
      assert.equal(cfg.hooks[kind].length, 1, `${kind} duplicated`);
    }
  });
});

describe("writeCursorRulesMdc", () => {
  it("creates .cursor/rules/axme-code.mdc with frontmatter and body", () => {
    writeCursorRulesMdc(ROOT, false);
    const path = join(ROOT, ".cursor", "rules", "axme-code.mdc");
    assert.ok(existsSync(path));
    const content = readFileSync(path, "utf-8");
    assert.match(content, /^---\nname: axme-code/m);
    assert.match(content, /alwaysApply: true/);
    assert.match(content, /## AXME Code/);
    assert.match(content, /Session Start \(MANDATORY\)/);
    assert.match(content, /axme_context/);
    // Cursor wording — not Claude
    assert.ok(content.includes("Cursor session"));
  });

  it("overwrites on re-run", () => {
    writeCursorRulesMdc(ROOT, false);
    const first = readFileSync(join(ROOT, ".cursor", "rules", "axme-code.mdc"), "utf-8");
    writeCursorRulesMdc(ROOT, true);
    const second = readFileSync(join(ROOT, ".cursor", "rules", "axme-code.mdc"), "utf-8");
    // Body content is canonical regardless of isWorkspace flag for now
    assert.equal(first, second);
  });
});
