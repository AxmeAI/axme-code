import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEmbedder, buildIndex, search } from "./search.ts";
import type { Item } from "./search.ts";

describe("benchmarks/lib/search", () => {
  it("loadEmbedder returns 384-dim vectors", async () => {
    const embedder = await loadEmbedder();
    assert.equal(embedder.dimension, 384);

    const vec = await embedder.embed("hello world");
    assert.equal(vec.length, 384);
    // Vector should be normalized (L2 norm ≈ 1)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(norm - 1.0) < 0.01, `norm should be ~1.0, got ${norm}`);
  });

  it("build + search returns relevant results", async () => {
    const embedder = await loadEmbedder();

    const items: Item[] = [
      { id: "d-042", text: "In async handlers always use async HTTP clients. Sync clients block the event loop.", metadata: { type: "decision" } },
      { id: "d-007", text: "Every file write goes through atomicWrite: write to temp file then rename.", metadata: { type: "decision" } },
      { id: "m-ci", text: "CI test files must use self-contained temp fixtures, never hardcoded absolute paths.", metadata: { type: "memory" } },
      { id: "m-safety", text: "AXME safety hook denies rm -rf on absolute paths via prefix match.", metadata: { type: "memory" } },
      { id: "d-036", text: "No direct commits to main. All changes must go through pull request.", metadata: { type: "decision" } },
    ];

    const index = await buildIndex(embedder, items);

    // Query about async HTTP should return d-042 as top result
    const results = await search(embedder, index, "should I use requests.get in async handler?", 3);
    assert.ok(results.length > 0, "should have results");
    assert.equal(results[0].id, "d-042", "d-042 should be top result for async HTTP query");
    assert.ok(results[0].score > 0.3, `score should be meaningful, got ${results[0].score}`);

    // Query about CI should return m-ci
    const ciResults = await search(embedder, index, "test fixtures hardcoded paths CI", 3);
    assert.equal(ciResults[0].id, "m-ci", "m-ci should be top for CI fixtures query");

    // Query about git workflow should return d-036
    const gitResults = await search(embedder, index, "can I push directly to main branch?", 3);
    assert.equal(gitResults[0].id, "d-036", "d-036 should be top for direct-to-main query");
  });

  it("empty index returns empty results", async () => {
    const embedder = await loadEmbedder();
    const index = await buildIndex(embedder, []);
    const results = await search(embedder, index, "anything", 5);
    assert.equal(results.length, 0);
  });

  it("topK limits results", async () => {
    const embedder = await loadEmbedder();
    const items: Item[] = Array.from({ length: 20 }, (_, i) => ({
      id: `item-${i}`,
      text: `This is test item number ${i} about software engineering`,
      metadata: {},
    }));
    const index = await buildIndex(embedder, items);
    const results = await search(embedder, index, "software engineering", 3);
    assert.equal(results.length, 3);
  });

  it("scores are sorted descending", async () => {
    const embedder = await loadEmbedder();
    const items: Item[] = [
      { id: "a", text: "TypeScript Node.js Express server", metadata: {} },
      { id: "b", text: "Python Django web framework", metadata: {} },
      { id: "c", text: "Gardening tips for tomatoes in spring", metadata: {} },
    ];
    const index = await buildIndex(embedder, items);
    const results = await search(embedder, index, "Node.js TypeScript backend", 3);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score, "should be sorted descending");
    }
    // "a" should be most relevant
    assert.equal(results[0].id, "a");
  });
});
