import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  initMemoryStore,
  saveMemory,
  listMemories,
  getMemory,
  deleteMemory,
  searchMemories,
  toMemorySlug,
  allMemoryContext,
  getMemorySections,
  showMemories,
} from "../src/storage/memory.js";

const ROOT = "/tmp/axme-memory-test";

const mem = (slug: string, type: "feedback" | "pattern" = "feedback", title?: string): any => ({
  slug,
  type,
  title: title || `Title for ${slug}`,
  description: `Description for ${slug}`,
  keywords: ["test", slug],
  source: "session" as const,
  sessionId: null,
  date: "2026-04-07",
  body: `Body for ${slug}`,
});

describe("memory store", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    initMemoryStore(ROOT);
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("saveMemory + getMemory round-trip", () => {
    const m = mem("round-trip");
    saveMemory(ROOT, m);
    const loaded = getMemory(ROOT, "round-trip");
    assert.ok(loaded);
    assert.equal(loaded.slug, "round-trip");
    assert.equal(loaded.title, "Title for round-trip");
    assert.equal(loaded.description, "Description for round-trip");
    assert.equal(loaded.body, "Body for round-trip");
    assert.equal(loaded.type, "feedback");
    assert.equal(loaded.date, "2026-04-07");
    assert.deepEqual(loaded.keywords, ["test", "round-trip"]);
  });

  it("listMemories returns all saved", () => {
    saveMemory(ROOT, mem("alpha"));
    saveMemory(ROOT, mem("beta"));
    saveMemory(ROOT, mem("gamma", "pattern"));
    const all = listMemories(ROOT);
    assert.equal(all.length, 3);
  });

  it("listMemories filtered by type - feedback", () => {
    saveMemory(ROOT, mem("fb-one"));
    saveMemory(ROOT, mem("fb-two"));
    saveMemory(ROOT, mem("pat-one", "pattern"));
    const feedbacks = listMemories(ROOT, "feedback");
    assert.equal(feedbacks.length, 2);
    assert.ok(feedbacks.every(m => m.type === "feedback"));
  });

  it("listMemories filtered by type - pattern", () => {
    saveMemory(ROOT, mem("fb-one"));
    saveMemory(ROOT, mem("pat-one", "pattern"));
    saveMemory(ROOT, mem("pat-two", "pattern"));
    const patterns = listMemories(ROOT, "pattern");
    assert.equal(patterns.length, 2);
    assert.ok(patterns.every(m => m.type === "pattern"));
  });

  it("deleteMemory removes and returns true", () => {
    saveMemory(ROOT, mem("to-delete"));
    assert.ok(getMemory(ROOT, "to-delete"));
    const result = deleteMemory(ROOT, "to-delete");
    assert.equal(result, true);
    assert.equal(getMemory(ROOT, "to-delete"), null);
  });

  it("deleteMemory on missing returns false", () => {
    const result = deleteMemory(ROOT, "nonexistent-slug");
    assert.equal(result, false);
  });

  it("searchMemories finds by keyword", () => {
    saveMemory(ROOT, mem("deploy-fix"));
    saveMemory(ROOT, mem("unrelated"));
    const results = searchMemories(ROOT, ["deploy-fix"]);
    assert.ok(results.length >= 1);
    assert.ok(results.some(m => m.slug === "deploy-fix"));
  });

  it("searchMemories returns empty for no match", () => {
    saveMemory(ROOT, mem("alpha"));
    const results = searchMemories(ROOT, ["zzz-no-match-xyz"]);
    assert.equal(results.length, 0);
  });

  it("toMemorySlug: lowercase, removes special chars, max 60 chars", () => {
    assert.equal(toMemorySlug("Hello World!"), "hello-world");
    assert.equal(toMemorySlug("  Foo@#Bar  "), "foo-bar");
    const long = "a".repeat(100);
    assert.ok(toMemorySlug(long).length <= 60);
  });

  it("allMemoryContext returns formatted string with sections", () => {
    saveMemory(ROOT, mem("ctx-fb"));
    saveMemory(ROOT, mem("ctx-pat", "pattern"));
    const ctx = allMemoryContext(ROOT);
    assert.ok(ctx.includes("Feedback"));
    assert.ok(ctx.includes("Patterns"));
    assert.ok(ctx.includes("Title for ctx-fb"));
    assert.ok(ctx.includes("Title for ctx-pat"));
  });

  it("getMemorySections returns array", () => {
    saveMemory(ROOT, mem("sec-fb"));
    saveMemory(ROOT, mem("sec-pat", "pattern"));
    const sections = getMemorySections(ROOT);
    assert.ok(Array.isArray(sections));
    assert.ok(sections.length >= 1);
    assert.ok(sections.some(s => s.includes("Feedback")));
    assert.ok(sections.some(s => s.includes("Patterns")));
  });

  it("getMemorySections returns empty for no memories", () => {
    const sections = getMemorySections(ROOT);
    assert.deepEqual(sections, []);
  });

  it("showMemories: formatted output with title and description", () => {
    saveMemory(ROOT, mem("show-me", "feedback", "My Title"));
    const output = showMemories(ROOT);
    assert.ok(output.includes("My Title"));
    assert.ok(output.includes("Description for show-me"));
    assert.ok(output.includes("[feedback]"));
  });

  it("showMemories returns placeholder for empty store", () => {
    const output = showMemories(ROOT);
    assert.ok(output.includes("No memories"));
  });

  it("two different slugs stored independently", () => {
    saveMemory(ROOT, mem("slug-a", "feedback", "Title A"));
    saveMemory(ROOT, mem("slug-b", "feedback", "Title B"));
    const a = getMemory(ROOT, "slug-a");
    const b = getMemory(ROOT, "slug-b");
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.title, "Title A");
    assert.equal(b.title, "Title B");
  });

  it("same title + same slug overwrites in place (this is how an entry is revised)", () => {
    saveMemory(ROOT, { ...mem("overwrite", "feedback", "Same title"), description: "Original description" });
    saveMemory(ROOT, { ...mem("overwrite", "feedback", "Same title"), description: "New description" });
    const loaded = getMemory(ROOT, "overwrite");
    assert.ok(loaded);
    assert.equal(loaded.description, "New description");
    const matches = listMemories(ROOT, "feedback").filter(m => m.slug === "overwrite");
    assert.equal(matches.length, 1);
  });

  it("different title on an occupied slug is suffixed, not silently overwritten", () => {
    // The defect this guards: two distinct memories collapsing onto one
    // filename destroyed the first one with no signal to anybody.
    saveMemory(ROOT, { ...mem("collide", "feedback", "First rule"), description: "First description" });
    const outcome = saveMemory(ROOT, { ...mem("collide", "feedback", "Second rule"), description: "Second description" });

    assert.notEqual(outcome.slug, "collide");
    assert.equal(outcome.collisionWith, "First rule");

    // Both survive and are readable back.
    const first = getMemory(ROOT, "collide");
    assert.ok(first);
    assert.equal(first.title, "First rule");
    const second = getMemory(ROOT, outcome.slug);
    assert.ok(second);
    assert.equal(second.title, "Second rule");
  });

  it("non-latin titles get distinct transliterated slugs, never a bare .md", () => {
    // Regression: a Cyrillic-only title reduced to the empty slug, landed as
    // the dotfile ".md", and the next such title overwrote it.
    const a = saveMemory(ROOT, { ...mem(toMemorySlug("Перекат даты"), "pattern", "Перекат даты"), description: "one" });
    const b = saveMemory(ROOT, { ...mem(toMemorySlug("Ловушка watchdog"), "pattern", "Ловушка watchdog"), description: "two" });

    assert.equal(a.slug, "perekat-daty");
    assert.equal(b.slug, "lovushka-watchdog");
    assert.notEqual(a.slug, b.slug);

    const patterns = listMemories(ROOT, "pattern").map(m => m.slug);
    assert.ok(patterns.includes("perekat-daty"));
    assert.ok(patterns.includes("lovushka-watchdog"));
  });

  it("strips a leaked tool-call frame instead of persisting it", () => {
    const outcome = saveMemory(ROOT, {
      ...mem("leaky", "feedback", "Leaky record"),
      description: 'Watchdog flaps on date rollover.</description>\n<parameter name="keywords">["bf_live"]',
    });
    assert.ok(outcome.cleanedFields.includes("description"));
    const loaded = getMemory(ROOT, outcome.slug);
    assert.ok(loaded);
    assert.equal(loaded.description, "Watchdog flaps on date rollover.");
  });
});
