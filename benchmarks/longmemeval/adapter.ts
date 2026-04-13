/**
 * LongMemEval adapter for AXME Code benchmark.
 *
 * Pipeline: sentence-level retrieval → expand to full sessions → reader.
 * Zero extra LLM calls at retrieval — all local (MiniLM embeddings + HNSW).
 *
 * Dataset source: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEmbedder, buildIndex, search } from "../lib/search.js";
import type { Embedder, Item } from "../lib/search.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "data", "longmemeval_s_cleaned.json");

// ─── Types ───────────────────────────────────────────────────────────

interface Turn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

export interface LongMemEvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: number[];
  haystack_dates: string[];
  haystack_session_ids: number[];
  haystack_sessions: Turn[][];
}

export interface RetrievalResult {
  sessionId: string;
  date: string;
  text: string;
  score: number;
}

// ─── Dataset loading ─────────────────────────────────────────────────

export function loadDataset(path?: string): LongMemEvalQuestion[] {
  const p = path ?? DATA_PATH;
  const raw = readFileSync(p, "utf-8");
  return JSON.parse(raw) as LongMemEvalQuestion[];
}

// ─── Sentence-level indexing ─────────────────────────────────────────

/**
 * Split user turns into individual sentences for embedding.
 */
function sessionsToSentenceItems(question: LongMemEvalQuestion): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < question.haystack_sessions.length; i++) {
    const session = question.haystack_sessions[i];
    const sessionId = String(question.haystack_session_ids[i]);
    const date = question.haystack_dates[i] ?? "";

    for (let t = 0; t < session.length; t++) {
      const turn = session[t];
      if (turn.role !== "user") continue;

      const sentences = turn.content
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 15);

      for (let s = 0; s < sentences.length; s++) {
        items.push({
          id: `${sessionId}_t${t}_s${s}`,
          text: `[${date}] ${sentences[s]}`,
          metadata: { sessionId, date, turnIndex: t, sentenceIndex: s },
        });
      }
    }
  }
  return items;
}

// ─── Retrieval ───────────────────────────────────────────────────────

/**
 * Retrieve top-K sentence chunks via embedding similarity.
 */
export async function retrieveSentences(
  embedder: Embedder,
  question: LongMemEvalQuestion,
  topK: number,
): Promise<RetrievalResult[]> {
  const items = sessionsToSentenceItems(question);
  const index = await buildIndex(embedder, items);
  const searchResults = await search(embedder, index, question.question, topK);

  return searchResults.map(r => ({
    sessionId: r.metadata.sessionId as string,
    date: r.metadata.date as string,
    text: r.text,
    score: r.score,
  }));
}

// ─── Full session expansion ──────────────────────────────────────────

/**
 * Expand retrieved sentence chunks to their full sessions (user turns only).
 * Dedup by sessionId, keep best score.
 */
export function expandToFullSessions(
  retrieved: RetrievalResult[],
  question: LongMemEvalQuestion,
): RetrievalResult[] {
  const sessionBest = new Map<string, RetrievalResult>();
  for (const r of retrieved) {
    const existing = sessionBest.get(r.sessionId);
    if (!existing || r.score > existing.score) {
      sessionBest.set(r.sessionId, r);
    }
  }

  const ranked = [...sessionBest.values()].sort((a, b) => b.score - a.score);

  const sessionIdToIdx = new Map<string, number>();
  for (let i = 0; i < question.haystack_session_ids.length; i++) {
    sessionIdToIdx.set(String(question.haystack_session_ids[i]), i);
  }

  return ranked.map(r => {
    const idx = sessionIdToIdx.get(r.sessionId);
    if (idx === undefined) return r;

    const session = question.haystack_sessions[idx];
    const fullText = session.map(t => `${t.role}: ${t.content}`).join("\n");
    const date = question.haystack_dates[idx] ?? r.date;

    return {
      sessionId: r.sessionId,
      date,
      text: `[${date}]\n${fullText}`,
      score: r.score,
    };
  });
}

// ─── Top-K by question type ─────────────────────────────────────────

export function getTopK(questionType: string, baseTopK: number): number {
  switch (questionType) {
    case "multi-session": return Math.max(baseTopK, 50);
    case "temporal-reasoning": return Math.max(baseTopK, 20);
    case "knowledge-update": return Math.max(baseTopK, 20);
    default: return baseTopK;
  }
}

// ─── Context formatting ──────────────────────────────────────────────

export function formatContext(
  results: RetrievalResult[],
  options?: { sortByDate?: boolean },
): string {
  const sorted = options?.sortByDate
    ? [...results].sort((a, b) => a.date.localeCompare(b.date))
    : results;

  const items = sorted.map((r, i) => ({
    rank: i + 1,
    session_date: r.date,
    relevance_score: Math.round(r.score * 1000) / 1000,
    content: r.text,
  }));

  const ordering = options?.sortByDate ? "chronological order" : "relevance";
  return `The following are relevant conversation excerpts retrieved from memory, ordered by ${ordering}:\n\n${JSON.stringify(items, null, 2)}`;
}
