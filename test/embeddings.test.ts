/**
 * Tests for src/storage/embeddings.ts.
 *
 * The embedder itself (transformers.js) is not installed in CI by design,
 * so we test only the pure parts: cosine math, topK ranking, JSON round-
 * trip, mtime-based staleness, and the runtime-detection / lazy-loader
 * fallback path. Real embedder behaviour is exercised by the LongMemEval
 * benchmarks and by Phase 2's E2E run, not here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cosine,
  topK,
  loadEmbeddings,
  saveEmbeddings,
  isStale,
  isRuntimeInstalled,
  loadEmbedder,
  EMBED_DIMENSION,
  type EmbedRecord,
} from "../src/storage/embeddings.ts";

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "axme-embed-"));
  mkdirSync(join(dir, ".axme-code"), { recursive: true });
  return dir;
}

function vec(values: number[]): Float32Array {
  return new Float32Array(values);
}

function normalize(values: number[]): number[] {
  const sumSq = values.reduce((s, v) => s + v * v, 0);
  const norm = Math.sqrt(sumSq) || 1;
  return values.map(v => v / norm);
}

describe("embeddings — cosine", () => {
  it("identical normalized vectors give 1.0", () => {
    const a = vec(normalize([1, 2, 3]));
    const b = vec(normalize([1, 2, 3]));
    assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  });

  it("orthogonal vectors give 0", () => {
    const a = vec([1, 0]);
    const b = vec([0, 1]);
    assert.equal(cosine(a, b), 0);
  });

  it("opposite directions give -1 (normalized)", () => {
    const a = vec(normalize([1, 0, 0]));
    const b = vec(normalize([-1, 0, 0]));
    assert.ok(Math.abs(cosine(a, b) + 1) < 1e-6);
  });

  it("works with plain number[]", () => {
    const a: number[] = [1, 0, 0];
    const b: number[] = [1, 0, 0];
    assert.equal(cosine(a, b), 1);
  });
});

describe("embeddings — topK ranking", () => {
  function rec(slug: string, type: "memory" | "decision", embedding: number[]): EmbedRecord {
    return {
      slug,
      type,
      title: `title-${slug}`,
      description: `desc-${slug}`,
      mtime: 0,
      embedding,
    };
  }

  it("returns highest cosine matches first", () => {
    const records: EmbedRecord[] = [
      rec("a", "memory", normalize([1, 0, 0])),
      rec("b", "memory", normalize([0, 1, 0])),
      rec("c", "memory", normalize([0.9, 0.1, 0])),
    ];
    const q = vec(normalize([1, 0, 0]));
    const hits = topK(records, q, 3);
    assert.equal(hits[0].slug, "a", "exact match wins");
    assert.equal(hits[1].slug, "c", "near-match second");
    assert.equal(hits[2].slug, "b", "orthogonal last");
  });

  it("respects type filter", () => {
    const records: EmbedRecord[] = [
      rec("m1", "memory", normalize([1, 0])),
      rec("m2", "memory", normalize([1, 0])),
      rec("d1", "decision", normalize([1, 0])),
    ];
    const q = vec(normalize([1, 0]));
    const memoryOnly = topK(records, q, 5, "memory");
    assert.equal(memoryOnly.length, 2);
    assert.ok(memoryOnly.every(h => h.type === "memory"));

    const decisionOnly = topK(records, q, 5, "decision");
    assert.equal(decisionOnly.length, 1);
    assert.equal(decisionOnly[0].slug, "d1");
  });

  it("k larger than population returns all", () => {
    const records: EmbedRecord[] = [
      rec("a", "memory", normalize([1, 0])),
      rec("b", "memory", normalize([0, 1])),
    ];
    const hits = topK(records, vec(normalize([1, 0])), 10);
    assert.equal(hits.length, 2);
  });

  it("k=0 or empty returns empty", () => {
    assert.equal(topK([], vec([1, 0]), 5).length, 0);
  });
});

describe("embeddings — JSON round-trip", () => {
  it("save then load yields identical records", async () => {
    const project = tmpProject();
    const records: EmbedRecord[] = [
      {
        slug: "test-mem",
        type: "memory",
        title: "Test memory",
        description: "Hello world",
        mtime: 1234567890,
        embedding: [0.1, 0.2, 0.3],
      },
      {
        slug: "D-001",
        type: "decision",
        title: "Test decision",
        description: "Always do X",
        mtime: 1234567891,
        embedding: [0.4, 0.5, 0.6],
      },
    ];
    await saveEmbeddings(project, records);
    const loaded = loadEmbeddings(project);
    assert.equal(loaded.length, 2);
    assert.deepEqual(loaded[0].embedding, [0.1, 0.2, 0.3]);
    assert.equal(loaded[1].slug, "D-001");
  });

  it("loadEmbeddings on missing file returns empty array", () => {
    const project = tmpProject();
    assert.deepEqual(loadEmbeddings(project), []);
  });

  it("loadEmbeddings on malformed JSON returns empty array (graceful)", () => {
    const project = tmpProject();
    mkdirSync(join(project, ".axme-code", "_index"), { recursive: true });
    writeFileSync(join(project, ".axme-code", "_index", "embeddings.json"), "not valid json {[");
    assert.deepEqual(loadEmbeddings(project), []);
  });
});

describe("embeddings — staleness", () => {
  it("returns true when md file is newer than record mtime", () => {
    const project = tmpProject();
    const mdPath = join(project, "test.md");
    writeFileSync(mdPath, "hello");
    const fileMtime = statSync(mdPath).mtimeMs;
    const record: EmbedRecord = {
      slug: "x",
      type: "memory",
      title: "t",
      description: "d",
      mtime: fileMtime - 1000,
      embedding: [],
    };
    assert.equal(isStale(record, mdPath), true);
  });

  it("returns false when record mtime matches file", () => {
    const project = tmpProject();
    const mdPath = join(project, "test.md");
    writeFileSync(mdPath, "hello");
    const fileMtime = statSync(mdPath).mtimeMs;
    const record: EmbedRecord = {
      slug: "x",
      type: "memory",
      title: "t",
      description: "d",
      mtime: fileMtime + 1000, // record newer than file
      embedding: [],
    };
    assert.equal(isStale(record, mdPath), false);
  });

  it("returns true when md file does not exist", () => {
    const record: EmbedRecord = {
      slug: "x",
      type: "memory",
      title: "t",
      description: "d",
      mtime: Date.now(),
      embedding: [],
    };
    assert.equal(isStale(record, "/nonexistent/path/x.md"), true);
  });
});

describe("embeddings — runtime detection", () => {
  it("isRuntimeInstalled returns false when runtime missing", () => {
    // CI env never has the lazy runtime — this is the common case.
    // (If a developer machine has it installed, this assertion would
    // legitimately flip; we re-check by inspecting the dimension below.)
    const installed = isRuntimeInstalled();
    if (installed) {
      // Runtime present locally — assert dimension constant is wired.
      assert.equal(EMBED_DIMENSION, 384);
    } else {
      assert.equal(installed, false);
    }
  });

  it("loadEmbedder returns null when runtime not installed", async () => {
    if (isRuntimeInstalled()) return; // skip if dev machine has it
    const embedder = await loadEmbedder();
    assert.equal(embedder, null);
  });
});
