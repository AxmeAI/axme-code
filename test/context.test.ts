import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import {
  getFullContextSections,
  getFullContext,
  getCloseContext,
} from "../src/tools/context.js";

const INITIALIZED_PROJECT = "/home/georgeb/axme-workspace/axme-code";
const INITIALIZED_WORKSPACE = "/home/georgeb/axme-workspace";
const UNINIT_PATH = "/tmp/axme-context-uninit-test";

beforeEach(() => {
  rmSync(UNINIT_PATH, { recursive: true, force: true });
  mkdirSync(UNINIT_PATH, { recursive: true });
});

afterEach(() => {
  rmSync(UNINIT_PATH, { recursive: true, force: true });
});

describe("getFullContextSections", () => {
  it("returns non-empty array", () => {
    const sections = getFullContextSections(INITIALIZED_PROJECT);
    assert.ok(Array.isArray(sections));
    assert.ok(sections.length > 0);
  });

  it("first section contains AXME Storage Root", () => {
    const sections = getFullContextSections(INITIALIZED_PROJECT);
    assert.ok(sections[0].includes("AXME Storage Root"));
  });

  it("includes Load Full Knowledge Base instruction", () => {
    const sections = getFullContextSections(INITIALIZED_PROJECT);
    const joined = sections.join("\n");
    assert.ok(joined.includes("Load Full Knowledge Base"));
  });

  it("with workspace_path includes safety rules", () => {
    const sections = getFullContextSections(INITIALIZED_PROJECT, INITIALIZED_WORKSPACE);
    const joined = sections.join("\n");
    assert.ok(joined.includes("Safety Rules") || joined.includes("Load Full Knowledge Base"));
  });
});

describe("getFullContext", () => {
  it("returns joined string", () => {
    const ctx = getFullContext(INITIALIZED_PROJECT);
    assert.ok(typeof ctx === "string");
    assert.ok(ctx.length > 0);
    assert.ok(ctx.includes("AXME Storage Root"));
  });
});

describe("getCloseContext", () => {
  it("returns string with Existing sections", () => {
    const ctx = getCloseContext(INITIALIZED_PROJECT);
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
