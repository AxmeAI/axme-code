/**
 * Knowledge-base search and on-demand fetch handlers.
 *
 * Three MCP tools:
 *   - axme_get_memory(slug)        — full body of one memory (any mode)
 *   - axme_get_decision(id_or_slug) — full body of one decision (any mode)
 *   - axme_search_kb(query, ...)    — semantic search across memories+decisions
 *
 * All read-only. axme_get_* always work (read .md files directly).
 * axme_search_kb requires the lazy-installed embeddings runtime — if absent,
 * returns a helpful message pointing to `axme-code config set context.mode search`.
 */

import { getMemory, listMemories } from "../storage/memory.js";
import { getDecision, listDecisions } from "../storage/decisions.js";
import {
  loadEmbedder,
  loadEmbeddings,
  topK,
  type EmbedType,
} from "../storage/embeddings.js";
import type { Memory, Decision } from "../types.js";

function formatMemory(m: Memory): string {
  const lines = [
    `# ${m.title}`,
    "",
    `- **type**: ${m.type}`,
    `- **slug**: ${m.slug}`,
    `- **date**: ${m.date}`,
    `- **source**: ${m.source}`,
    ...(m.scope ? [`- **scope**: ${m.scope.join(", ")}`] : []),
    ...(m.keywords && m.keywords.length ? [`- **keywords**: ${m.keywords.join(", ")}`] : []),
    "",
    "## Description",
    "",
    m.description,
  ];
  if (m.body) {
    lines.push("", "## Body", "", m.body);
  }
  return lines.join("\n");
}

function formatDecision(d: Decision): string {
  const lines = [
    `# ${d.id}: ${d.title}`,
    "",
    `- **enforce**: ${d.enforce ?? "-"}`,
    `- **status**: ${d.status ?? "active"}`,
    `- **date**: ${d.date}`,
    `- **source**: ${d.source}`,
    ...(d.scope ? [`- **scope**: ${d.scope.join(", ")}`] : []),
    "",
    "## Decision",
    "",
    d.decision,
  ];
  if (d.reasoning) {
    lines.push("", "## Reasoning", "", d.reasoning);
  }
  return lines.join("\n");
}

export function getMemoryTool(projectPath: string, slug: string): string {
  const m = getMemory(projectPath, slug);
  if (!m) {
    return `Memory not found: '${slug}'. Use axme_memories to list available slugs, or axme_search_kb to find by topic.`;
  }
  return formatMemory(m);
}

export function getDecisionTool(projectPath: string, idOrSlug: string): string {
  const d = getDecision(projectPath, idOrSlug);
  if (!d) {
    return `Decision not found: '${idOrSlug}'. Use axme_decisions to list, or axme_search_kb to find by topic.`;
  }
  return formatDecision(d);
}

export interface SearchKbInput {
  query: string;
  k?: number;
  type?: EmbedType;
}

/**
 * Semantic search. Falls back gracefully if embeddings runtime is not
 * installed — returns a one-line install hint instead of throwing, so
 * agents calling this tool always get a usable response.
 */
export async function searchKbTool(
  projectPath: string,
  input: SearchKbInput,
): Promise<string> {
  const k = Math.max(1, Math.min(input.k ?? 5, 50));

  const embedder = await loadEmbedder();
  if (!embedder) {
    return [
      "Semantic search runtime is not installed.",
      "",
      "To enable: `axme-code config set context.mode search`",
      "(installs ~100MB transformers.js + ~30MB MiniLM model, one-time).",
      "",
      "In the meantime, list all entries with axme_memories / axme_decisions",
      "and use axme_get_memory(slug) / axme_get_decision(id) for full bodies.",
    ].join("\n");
  }

  const records = loadEmbeddings(projectPath);
  if (records.length === 0) {
    // Fall back to a hint rather than rebuild here (reindex is a CLI flow).
    const memCount = listMemories(projectPath).length;
    const decCount = listDecisions(projectPath).length;
    if (memCount + decCount === 0) {
      return "Knowledge base is empty — no memories or decisions to search.";
    }
    return [
      `Embeddings index is empty (${memCount} memories, ${decCount} decisions on disk).`,
      "Run `axme-code reindex` to build the index, then retry the search.",
    ].join("\n");
  }

  const qvec = await embedder.embed(input.query);
  const hits = topK(records, qvec, k, input.type);
  if (hits.length === 0) {
    return `No matches in ${records.length} indexed entries for query: "${input.query}".`;
  }

  const lines: string[] = [
    `Top ${hits.length} matches (of ${records.length} indexed):`,
    "",
  ];
  for (const h of hits) {
    const score = h.score.toFixed(3);
    const tag = h.type === "memory" ? "memory" : "decision";
    lines.push(`- [${tag}] **${h.slug}** (score ${score}) — ${h.title}`);
    if (h.description) lines.push(`  ${h.description}`);
  }
  lines.push("", "Fetch a full body via axme_get_memory(slug) or axme_get_decision(id_or_slug).");
  return lines.join("\n");
}
