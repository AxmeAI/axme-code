/**
 * Standalone semantic search for benchmarks.
 *
 * Uses @huggingface/transformers (ONNX MiniLM-L6-v2) for embeddings and
 * hnswlib-node for approximate nearest neighbor search. NOT imported by
 * the AXME Code product — lives only in benchmarks/.
 *
 * Usage:
 *   const embedder = await loadEmbedder();
 *   const index = await buildIndex(embedder, items);
 *   const results = await search(embedder, index, "query", 10);
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { HierarchicalNSW } = require("hnswlib-node") as typeof import("hnswlib-node");

// ─── Types ───────────────────────────────────────────────────────────

export interface Item {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  score: number; // cosine similarity, higher = more similar
}

export interface SearchIndex {
  hnsw: HierarchicalNSW;
  items: Item[];
}

export interface Embedder {
  embed: (text: string) => Promise<Float32Array>;
  embedBatch: (texts: string[]) => Promise<Float32Array[]>;
  dimension: number;
}

// ─── Embedder ────────────────────────────────────────────────────────

let _cachedEmbedder: Embedder | null = null;

/**
 * Load the MiniLM-L6-v2 sentence embedding model.
 *
 * First call downloads ~30MB ONNX model to ~/.cache/huggingface/.
 * Subsequent calls return the cached instance.
 */
export async function loadEmbedder(): Promise<Embedder> {
  if (_cachedEmbedder) return _cachedEmbedder;

  // Dynamic import — @huggingface/transformers is ESM-only
  const { pipeline } = await import("@huggingface/transformers");
  const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "fp32",
  });

  const DIMENSION = 384; // MiniLM-L6-v2 output dimension

  async function embed(text: string): Promise<Float32Array> {
    const result = await pipe(text, { pooling: "mean", normalize: true });
    // result.data is a Float32Array of length DIMENSION
    return new Float32Array(result.data as ArrayLike<number>);
  }

  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    // Process in small batches to avoid OOM on large datasets
    const BATCH_SIZE = 32;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(t => embed(t)));
      results.push(...batchResults);
      if (texts.length > 100 && i % 100 === 0) {
        process.stderr.write(`  embedded ${i}/${texts.length}\r`);
      }
    }
    if (texts.length > 100) process.stderr.write("\n");
    return results;
  }

  _cachedEmbedder = { embed, embedBatch, dimension: DIMENSION };
  return _cachedEmbedder;
}

// ─── Index ───────────────────────────────────────────────────────────

/**
 * Build an HNSW index from items.
 *
 * Embeds all item texts (may take a while for large datasets), then
 * inserts into an in-memory HNSW index for fast kNN queries.
 */
export async function buildIndex(
  embedder: Embedder,
  items: Item[],
): Promise<SearchIndex> {
  if (items.length === 0) {
    const hnsw = new HierarchicalNSW("cosine", embedder.dimension);
    hnsw.initIndex(1); // HNSW requires at least maxElements=1
    return { hnsw, items: [] };
  }

  const texts = items.map(it => it.text);
  const vectors = await embedder.embedBatch(texts);

  const hnsw = new HierarchicalNSW("cosine", embedder.dimension);
  hnsw.initIndex(items.length, 16, 200); // M=16, efConstruction=200
  hnsw.setEf(50);

  for (let i = 0; i < items.length; i++) {
    hnsw.addPoint(Array.from(vectors[i]), i);
  }

  return { hnsw, items };
}

// ─── Search ──────────────────────────────────────────────────────────

/**
 * Semantic search: embed query → HNSW kNN → ranked results.
 *
 * Returns results sorted by descending cosine similarity.
 * Score range: 0 (orthogonal) to 1 (identical).
 */
export async function search(
  embedder: Embedder,
  index: SearchIndex,
  query: string,
  topK: number = 10,
): Promise<SearchResult[]> {
  if (index.items.length === 0) return [];

  const qvec = await embedder.embed(query);
  const k = Math.min(topK, index.items.length);
  const result = index.hnsw.searchKnn(Array.from(qvec), k);

  // hnswlib returns distances (1 - cosine_similarity for "cosine" space)
  // so score = 1 - distance
  const results: SearchResult[] = [];
  for (let i = 0; i < result.neighbors.length; i++) {
    const idx = result.neighbors[i];
    const item = index.items[idx];
    results.push({
      id: item.id,
      text: item.text,
      metadata: item.metadata,
      score: 1 - result.distances[i],
    });
  }

  // Sort by score descending (hnswlib already returns in order, but be safe)
  results.sort((a, b) => b.score - a.score);
  return results;
}
