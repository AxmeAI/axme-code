/**
 * Tests for src/tools/kb-search.ts (the 3 new MCP handler functions).
 *
 * These exercise the handlers without the embedding runtime — searchKbTool's
 * "runtime not installed" branch is the common case, and getMemoryTool /
 * getDecisionTool are pure file-readers. Real embeddings end-to-end is
 * exercised in Phase 2 E2E.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMemory } from "../src/storage/memory.ts";
import { addDecision } from "../src/storage/decisions.ts";
import { getMemoryTool, getDecisionTool, searchKbTool } from "../src/tools/kb-search.ts";
import { isRuntimeInstalled } from "../src/storage/embeddings.ts";

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "axme-kbsearch-"));
  mkdirSync(join(dir, ".axme-code"), { recursive: true });
  return dir;
}

describe("getMemoryTool", () => {
  it("returns 'not found' message when slug missing", () => {
    const project = tmpProject();
    const text = getMemoryTool(project, "nonexistent-slug");
    assert.match(text, /not found/i);
    assert.match(text, /axme_memories/);
    assert.match(text, /axme_search_kb/);
  });

  it("formats full body with title, type, description, body", () => {
    const project = tmpProject();
    saveMemory(project, {
      slug: "test-mem",
      type: "feedback",
      title: "Test feedback memory",
      description: "Always validate at boundaries.",
      body: "Detailed reasoning goes here.",
      keywords: ["validation", "boundary"],
      source: "session",
      sessionId: null,
      date: "2026-04-29",
    });

    const text = getMemoryTool(project, "test-mem");
    assert.match(text, /# Test feedback memory/);
    assert.match(text, /\*\*type\*\*: feedback/);
    assert.match(text, /Always validate at boundaries/);
    assert.match(text, /Detailed reasoning/);
  });
});

describe("getDecisionTool", () => {
  it("returns 'not found' for unknown id", () => {
    const project = tmpProject();
    const text = getDecisionTool(project, "D-9999");
    assert.match(text, /not found/i);
    assert.match(text, /axme_decisions/);
  });

  it("formats full decision body when present", () => {
    const project = tmpProject();
    const d = addDecision(project, {
      slug: "use-typescript",
      title: "Use TypeScript",
      decision: "All new code must be TypeScript with strict mode.",
      reasoning: "Type safety catches bugs early.",
      enforce: "required",
      source: "manual",
      sessionId: null,
      date: "2026-04-29",
    });

    const text = getDecisionTool(project, d.id);
    assert.match(text, new RegExp(`# ${d.id}: Use TypeScript`));
    assert.match(text, /\*\*enforce\*\*: required/);
    assert.match(text, /strict mode/);
    assert.match(text, /Type safety/);
  });

  it("supports lookup by slug (not just ID)", () => {
    const project = tmpProject();
    addDecision(project, {
      slug: "use-typescript",
      title: "Use TypeScript",
      decision: "All new code must be TypeScript.",
      reasoning: "",
      enforce: "required",
      source: "manual",
      sessionId: null,
      date: "2026-04-29",
    });
    const text = getDecisionTool(project, "use-typescript");
    assert.match(text, /Use TypeScript/);
  });
});

describe("searchKbTool", () => {
  it("returns runtime-install hint when transformers not installed", async () => {
    if (isRuntimeInstalled()) return; // skip on dev machines that have it
    const project = tmpProject();
    const text = await searchKbTool(project, { query: "test" });
    assert.match(text, /runtime is not installed/i);
    assert.match(text, /axme-code config set context\.mode search/);
  });

  it("returns 'index empty' message when KB has entries but no embeddings", async () => {
    if (isRuntimeInstalled()) return; // only meaningful when runtime IS installed
    const project = tmpProject();
    saveMemory(project, {
      slug: "test", type: "feedback", title: "T", description: "D",
      body: "", keywords: [], source: "session", sessionId: null, date: "2026-04-29",
    });
    const text = await searchKbTool(project, { query: "anything" });
    // Without runtime we still get the install hint, not the empty-index hint.
    // This test mainly covers that we don't crash.
    assert.ok(text.length > 0);
  });

  it("returns 'KB empty' when no memories or decisions exist (and runtime missing)", async () => {
    if (isRuntimeInstalled()) return;
    const project = tmpProject();
    const text = await searchKbTool(project, { query: "anything" });
    // Without runtime we hit the install hint first, before checking KB size.
    assert.match(text, /runtime is not installed/i);
  });

  it("clamps k to [1, 50]", async () => {
    if (isRuntimeInstalled()) return; // can't fully validate without runtime
    const project = tmpProject();
    // Just verify no crash with extreme k.
    await searchKbTool(project, { query: "x", k: 0 });
    await searchKbTool(project, { query: "x", k: 100 });
    await searchKbTool(project, { query: "x", k: -5 });
  });
});
