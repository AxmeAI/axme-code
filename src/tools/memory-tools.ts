/**
 * Memory tools - axme_save_memory, axme_search_memory.
 */

import { saveMemory, searchMemories, listMemories, toMemorySlug, showMemories } from "../storage/memory.js";
import { logMemorySaved } from "../storage/worklog.js";
import { readConfig } from "../storage/config.js";
import { checkOverrun, findDuplicateCandidates, formatDuplicateNote } from "../storage/save-feedback.js";
import type { Memory, MemoryType } from "../types.js";

export interface SaveMemoryInput {
  type: MemoryType;
  title: string;
  description: string;
  body?: string;
  keywords?: string[];
  scope?: string[];
}

export interface SaveMemoryResult {
  slug: string;
  saved: boolean;
  /** Advisory lines appended to the tool result — format and dedup guidance. */
  notes: string[];
}

export function saveMemoryTool(
  projectPath: string,
  input: SaveMemoryInput,
  sessionId?: string,
): SaveMemoryResult {
  const slug = toMemorySlug(input.title);
  const today = new Date().toISOString().slice(0, 10);
  const config = readConfig(projectPath);

  // Look for near-duplicates BEFORE the write, so an exact-title update
  // (which overwrites in place) does not report itself as its own duplicate.
  const candidates = findDuplicateCandidates(projectPath, "memory", input.title)
    .filter(c => c.ref !== slug);

  const memory: Memory = {
    slug,
    type: input.type,
    title: input.title,
    description: input.description,
    body: input.body ?? "",
    keywords: input.keywords ?? extractKeywords(input.title + " " + input.description),
    source: "session",
    sessionId: sessionId ?? null,
    date: today,
    ...(input.scope ? { scope: input.scope } : {}),
  };

  const outcome = saveMemory(projectPath, memory);

  if (sessionId) {
    logMemorySaved(projectPath, sessionId, outcome.slug, input.type);
  }

  const notes: string[] = [];
  if (outcome.cleanedFields.length > 0) {
    // Surfaced rather than swallowed: a stripped field means the client
    // serialized the call malformed, and the agent should verify the saved
    // text rather than assume what it composed is what landed.
    notes.push(
      `WARNING: leaked tool-call markup was stripped from: ${outcome.cleanedFields.join(", ")}. ` +
      `Re-read the entry with axme_get_memory("${outcome.slug}") and re-save if content was lost.`,
    );
  }
  if (outcome.collisionWith) {
    notes.push(
      `WARNING: slug "${slug}" was already held by a different memory ("${outcome.collisionWith}"). ` +
      `Saved as "${outcome.slug}" instead of overwriting it.`,
    );
  }
  notes.push(...checkOverrun({
    kind: "memory",
    loadedText: input.description,
    hasBody: !!input.body?.trim(),
    excerptChars: config.catalogExcerptChars,
  }));
  notes.push(...formatDuplicateNote("memory", candidates));

  return { slug: outcome.slug, saved: true, notes };
}

export function searchMemoryTool(
  projectPath: string,
  query: string,
): { results: Array<{ slug: string; type: string; title: string; description: string }>; count: number } {
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const results = searchMemories(projectPath, keywords);

  return {
    results: results.slice(0, 20).map(m => ({
      slug: m.slug,
      type: m.type,
      title: m.title,
      description: m.description,
    })),
    count: results.length,
  };
}

export function listMemoriesTool(projectPath: string, type?: MemoryType): string {
  return showMemories(projectPath, type);
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "shall", "can", "need", "dare", "to", "of",
    "in", "for", "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over", "under",
    "again", "further", "then", "once", "and", "but", "or", "nor", "not", "so", "yet",
    "both", "either", "neither", "each", "every", "all", "any", "few", "more", "most",
    "other", "some", "such", "no", "only", "own", "same", "than", "too", "very",
    "just", "because", "if", "when", "while", "that", "this", "these", "those"]);

  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .slice(0, 10);
}
