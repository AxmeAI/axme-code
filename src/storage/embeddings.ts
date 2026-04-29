/**
 * Semantic search embeddings for memories and decisions.
 *
 * Adapted from benchmarks/lib/search.ts. HNSW dropped — at AXME-scale KBs
 * (typically <=1000 entries) brute-force cosine over Float32Array beats
 * HNSW (no native binding, no extra disk, <10ms query). Uses MiniLM-L6-v2
 * (Xenova/all-MiniLM-L6-v2) via @huggingface/transformers — pure JS+WASM,
 * no native deps. Embeddings normalized at extraction so cosine == dot.
 *
 * Runtime install: @huggingface/transformers (~100MB node_modules + ~30MB
 * ONNX weights cached at ~/.cache/huggingface/) is NOT bundled. The CLI
 * subcommand `axme-code config set context.mode search` installs it into
 * ~/.local/share/axme-code/runtime/ on opt-in. If the package is not
 * present, every embeddings function returns null and callers fall back
 * to "search mode unavailable, KB still works in full mode".
 *
 * Storage: .axme-code/_index/embeddings.json (gitignored), shape:
 *   [{ slug, type: "memory"|"decision", title, description, mtime, embedding: number[384] }]
 *
 * Concurrency: in-process Promise mutex on writes (cloned from
 * src/storage/decisions.ts:387). Cross-process atomicity comes from
 * atomicWrite in storage/engine.ts.
 */

import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, ensureDir, readSafe } from "./engine.js";

export type EmbedType = "memory" | "decision";

export interface EmbedRecord {
  slug: string;
  type: EmbedType;
  title: string;
  description: string;
  mtime: number;
  embedding: number[];
}

export interface SearchHit {
  slug: string;
  type: EmbedType;
  title: string;
  description: string;
  score: number;
}

export interface Embedder {
  embed: (text: string) => Promise<Float32Array>;
  dimension: number;
}

export const EMBED_DIMENSION = 384;
const RUNTIME_DIR = join(homedir(), ".local", "share", "axme-code", "runtime");
const INDEX_DIRNAME = "_index";
const EMBEDDINGS_FILENAME = "embeddings.json";

function indexDir(projectPath: string): string {
  return join(projectPath, ".axme-code", INDEX_DIRNAME);
}

function embeddingsPath(projectPath: string): string {
  return join(indexDir(projectPath), EMBEDDINGS_FILENAME);
}

/**
 * Path where the lazy-installed transformers runtime lives. Same on every
 * platform — `homedir()` resolves to %USERPROFILE% on Windows.
 */
export function runtimeDir(): string {
  return RUNTIME_DIR;
}

export function isRuntimeInstalled(): boolean {
  return existsSync(join(RUNTIME_DIR, "node_modules", "@huggingface", "transformers"));
}

let _cachedEmbedder: Embedder | null = null;

/**
 * Load the MiniLM-L6-v2 sentence embedding pipeline from the lazy-installed
 * runtime. Returns null if the runtime is not installed yet — caller is
 * expected to fall through to a "search unavailable" message.
 */
export async function loadEmbedder(): Promise<Embedder | null> {
  if (_cachedEmbedder) return _cachedEmbedder;
  if (!isRuntimeInstalled()) return null;

  // Dynamic import via createRequire so we can resolve from the lazy runtime
  // location at runtime regardless of where the CLI bundle lives. Typed as
  // `any` because @huggingface/transformers is intentionally NOT a build-time
  // dependency — it's lazy-installed on opt-in.
  const runtimeRequire = createRequire(join(RUNTIME_DIR, "node_modules", ".package-lock.json"));
  let mod: any;
  try {
    const requirePath = runtimeRequire.resolve("@huggingface/transformers");
    mod = await import(requirePath);
  } catch {
    return null;
  }

  const pipe = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "fp32",
  });

  async function embed(text: string): Promise<Float32Array> {
    const result = await pipe(text, { pooling: "mean", normalize: true });
    return new Float32Array(result.data as ArrayLike<number>);
  }

  _cachedEmbedder = { embed, dimension: EMBED_DIMENSION };
  return _cachedEmbedder;
}

/** @internal Reset cached embedder. Tests only. */
export function _resetEmbedderCache(): void {
  _cachedEmbedder = null;
}

/**
 * Cosine similarity for two unit-normalized Float32Arrays.
 * Since MiniLM output is normalized (we pass `normalize: true`), cosine
 * collapses to a plain dot product.
 */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Read the on-disk embeddings index. Returns [] if the file is missing or
 * malformed (we prefer "no index" over crashing the agent's session).
 */
export function loadEmbeddings(projectPath: string): EmbedRecord[] {
  const raw = readSafe(embeddingsPath(projectPath));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as EmbedRecord[];
  } catch {
    return [];
  }
}

let _writeQueue: Promise<void> = Promise.resolve();

/**
 * Atomically write the full embeddings index. Serialized in-process via a
 * single Promise mutex so concurrent saveMemory/addDecision calls don't
 * race the embeddings.json file.
 */
export function saveEmbeddings(projectPath: string, records: EmbedRecord[]): Promise<void> {
  _writeQueue = _writeQueue.then(() => {
    ensureDir(indexDir(projectPath));
    const json = JSON.stringify(records);
    atomicWrite(embeddingsPath(projectPath), json);
  }).catch(() => { /* swallow; caller already logged */ });
  return _writeQueue;
}

/** True if the .md file underlying a record has been touched since embed. */
export function isStale(record: EmbedRecord, mdPath: string): boolean {
  if (!existsSync(mdPath)) return true;
  return statSync(mdPath).mtimeMs > record.mtime;
}

/**
 * Brute-force top-K cosine search over the in-memory record array.
 * Optional `type` filter (memory or decision) — applied before ranking
 * so we don't pay for cosine on records we'd discard.
 */
export function topK(
  records: EmbedRecord[],
  qvec: Float32Array,
  k: number,
  type?: EmbedType,
): SearchHit[] {
  const filtered = type ? records.filter(r => r.type === type) : records;
  const scored = filtered.map(r => ({
    slug: r.slug,
    type: r.type,
    title: r.title,
    description: r.description,
    score: cosine(qvec, r.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(k, scored.length));
}

/**
 * Embed `text` and append-or-replace the record for (slug, type) in the
 * persisted index. Synchronous from the caller's POV: blocks ~50-200ms
 * for the embed call. Used by saveMemory and addDecision hooks.
 *
 * Returns true if the record was written, false if embedder unavailable.
 */
export async function upsertEmbedding(
  projectPath: string,
  embedder: Embedder,
  record: Omit<EmbedRecord, "embedding">,
  text: string,
): Promise<boolean> {
  const vec = await embedder.embed(text);
  const records = loadEmbeddings(projectPath);
  const idx = records.findIndex(r => r.slug === record.slug && r.type === record.type);
  const next: EmbedRecord = { ...record, embedding: Array.from(vec) };
  if (idx >= 0) records[idx] = next;
  else records.push(next);
  await saveEmbeddings(projectPath, records);
  return true;
}

/** Drop a record from the index by (slug, type). No-op if absent. */
export async function removeEmbedding(
  projectPath: string,
  slug: string,
  type: EmbedType,
): Promise<void> {
  const records = loadEmbeddings(projectPath);
  const next = records.filter(r => !(r.slug === slug && r.type === type));
  if (next.length === records.length) return;
  await saveEmbeddings(projectPath, next);
}

/**
 * High-level "embed this entry now" helper used by the MCP save handlers.
 *
 * Skips silently when:
 *   - context.mode is not "search" (no point indexing if no one will query)
 *   - the embeddings runtime is not installed
 *   - the embed call itself throws (we never fail the save because of search)
 *
 * Callers should `await` this — total wall time is ~50-200ms per call once
 * the embedder is warm. First call after a process start pays the model
 * load cost (~2s).
 */
export async function embedKbEntry(
  projectPath: string,
  slug: string,
  type: EmbedType,
  title: string,
  description: string,
  contextMode: "full" | "search",
): Promise<void> {
  if (contextMode !== "search") return;
  try {
    const embedder = await loadEmbedder();
    if (!embedder) return;
    const text = `${title}. ${description}`;
    await upsertEmbedding(
      projectPath,
      embedder,
      { slug, type, title, description, mtime: Date.now() },
      text,
    );
  } catch (e) {
    process.stderr.write(`AXME embed: failed to index ${type} '${slug}': ${(e as Error).message}\n`);
  }
}
