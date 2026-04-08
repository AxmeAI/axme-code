import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getFullContextSections,
  getFullContext,
  getCloseContext,
} from "../src/tools/context.js";

const TEST_ROOT = "/tmp/axme-context-test";
const PROJECT = join(TEST_ROOT, "project");
const WORKSPACE = TEST_ROOT;
const UNINIT_PATH = "/tmp/axme-context-uninit-test";

function setupTestProject() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  const axme = join(PROJECT, ".axme-code");
  mkdirSync(join(axme, "oracle"), { recursive: true });
  mkdirSync(join(axme, "decisions"), { recursive: true });
  mkdirSync(join(axme, "memory", "feedback"), { recursive: true });
  mkdirSync(join(axme, "memory", "patterns"), { recursive: true });
  mkdirSync(join(axme, "safety"), { recursive: true });
  mkdirSync(join(axme, "sessions"), { recursive: true });

  writeFileSync(join(axme, "oracle", "stack.md"), "# Stack\nNode.js 20, TypeScript");
  writeFileSync(join(axme, "oracle", "structure.md"), "# Structure\nsrc/ test/");
  writeFileSync(join(axme, "oracle", "patterns.md"), "# Patterns\nESM modules");
  writeFileSync(join(axme, "oracle", "glossary.md"), "# Glossary\nMCP = Model Context Protocol");
  writeFileSync(join(axme, "config.yaml"), "model: claude-sonnet-4-6\npresets:\n  - essential-safety\n");
  writeFileSync(join(axme, "safety", "rules.yaml"), `git:\n  protectedBranches: [main]\n  allowDirectPushToMain: false\n  allowForcePush: false\nbash:\n  deniedPrefixes:\n    - "rm -rf /"\n  allowedPrefixes: []\nfilesystem:\n  deniedPaths: []\n  readOnlyPaths: []\n`);
  writeFileSync(join(axme, "decisions", "index.md"), "# Decisions\n");
  writeFileSync(join(axme, "decisions", "D-001-test-decision.md"), `---\nid: D-001\nslug: test-decision\ntitle: Test decision\nenforce: required\nstatus: active\ndate: "2026-04-01"\nsource: manual\n---\nTest decision body.\n`);
}

beforeEach(() => {
  setupTestProject();
  rmSync(UNINIT_PATH, { recursive: true, force: true });
  mkdirSync(UNINIT_PATH, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  rmSync(UNINIT_PATH, { recursive: true, force: true });
});

describe("getFullContextSections", () => {
  it("returns non-empty array", () => {
    const sections = getFullContextSections(PROJECT);
    assert.ok(Array.isArray(sections));
    assert.ok(sections.length > 0);
  });

  it("first section contains AXME Storage Root", () => {
    const sections = getFullContextSections(PROJECT);
    assert.ok(sections[0].includes("AXME Storage Root"));
  });

  it("includes Load Full Knowledge Base instruction", () => {
    const sections = getFullContextSections(PROJECT);
    const joined = sections.join("\n");
    assert.ok(joined.includes("Load Full Knowledge Base"));
  });

  it("includes safety rules in output", () => {
    const sections = getFullContextSections(PROJECT);
    const joined = sections.join("\n");
    assert.ok(joined.includes("Safety Rules") || joined.includes("Protected branches"));
  });
});

describe("getFullContext", () => {
  it("returns joined string", () => {
    const ctx = getFullContext(PROJECT);
    assert.ok(typeof ctx === "string");
    assert.ok(ctx.length > 0);
    assert.ok(ctx.includes("AXME Storage Root"));
  });
});

describe("getCloseContext", () => {
  it("returns string with Existing sections", () => {
    const ctx = getCloseContext(PROJECT);
    assert.ok(typeof ctx === "string");
    assert.ok(ctx.includes("Existing"));
  });
});

describe("uninitialized project", () => {
  it("returns message with not initialized", () => {
    const sections = getFullContextSections(UNINIT_PATH);
    const joined = sections.join("\n");
    assert.ok(joined.toLowerCase().includes("not initialized"));
  });
});
