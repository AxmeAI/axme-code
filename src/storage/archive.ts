/**
 * Archival of memories and decisions.
 *
 * Why this exists: axme-code shipped `axme_save_memory` and
 * `axme_save_decision` but nothing to retire an entry, while the knowledge
 * bases it builds carry a rule of their own — "write to axme-code storage
 * via MCP tools only, never manually". An agent asked to clean up therefore
 * had no legal move: no tool to do it with, and a rule against doing it by
 * hand. The first real compaction had to bypass MCP entirely with file
 * operations, which is exactly the failure mode the rule exists to prevent.
 *
 * Design constraints, both learned from that compaction:
 *
 *  - Archive, never delete. Everything lands under `.axme-code/archive/`
 *    with its original subdirectory structure, so a mistaken archival is
 *    undone by moving one file back.
 *  - A decision must be marked before it moves. `status: superseded` +
 *    `supersededBy` (or `status: revoked` + `revokedAt`/`revokedReason`)
 *    are written into the file itself, so the archived copy still explains
 *    why it left. An archive of unmarked files is a graveyard nobody can
 *    read.
 */

import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, ensureDir, pathExists } from "./engine.js";
import { setFrontmatterValue } from "./kb-doctor.js";
import { getMemory, saveMemory } from "./memory.js";
import { getDecision, rebuildDecisionIndex } from "./decisions.js";
import { AXME_CODE_DIR } from "../types.js";
import type { Memory } from "../types.js";

const ARCHIVE_DIR = "archive";

export interface ArchiveResult {
  ok: boolean;
  /** Path the entry now lives at, when ok. */
  archivedTo?: string;
  /** Human-readable reason when !ok. */
  error?: string;
}

function archiveRoot(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, ARCHIVE_DIR);
}

/**
 * Move one memory into the archive.
 *
 * The reason is stamped into the archived file's frontmatter rather than
 * kept in a side ledger — the file has to be self-explanatory to whoever
 * finds it later, possibly a different agent months on.
 */
export function archiveMemory(projectPath: string, slug: string, reason: string): ArchiveResult {
  const memory = getMemory(projectPath, slug);
  if (!memory) return { ok: false, error: `Memory "${slug}" not found` };

  const subdir = memory.type === "feedback" ? "feedback" : "patterns";
  const source = join(projectPath, AXME_CODE_DIR, "memory", subdir, `${slug}.md`);
  if (!pathExists(source)) {
    return { ok: false, error: `Memory file for "${slug}" not found at ${source}` };
  }

  const destDir = join(archiveRoot(projectPath), "memory", subdir);
  ensureDir(destDir);
  const dest = uniquePath(destDir, slug);

  let raw: string;
  try { raw = readFileSync(source, "utf-8"); } catch (e: any) {
    return { ok: false, error: `Cannot read ${source}: ${e?.message ?? e}` };
  }

  const stamped = setFrontmatterValue(
    setFrontmatterValue(raw, "archivedAt", new Date().toISOString()),
    "archivedReason", oneLine(reason),
  );
  atomicWrite(dest, stamped);
  try { unlinkSync(source); } catch (e: any) {
    return { ok: false, error: `Archived copy written to ${dest} but original could not be removed: ${e?.message ?? e}` };
  }
  return { ok: true, archivedTo: dest };
}

/**
 * Move one decision into the archive, marking it first.
 *
 * `supersededBy` is optional: a decision can leave either because a newer
 * one replaced it (supersede) or because it stopped applying at all
 * (revoke). Both are recorded in the file before the move.
 */
export function archiveDecision(
  projectPath: string, idOrSlug: string, reason: string, supersededBy?: string,
): ArchiveResult {
  const decision = getDecision(projectPath, idOrSlug);
  if (!decision) return { ok: false, error: `Decision "${idOrSlug}" not found` };

  if (supersededBy) {
    const replacement = getDecision(projectPath, supersededBy);
    if (!replacement) {
      // Refuse rather than write a dangling pointer: a supersededBy that
      // resolves to nothing is worse than no marking at all, because it
      // reads as "go look at D-140" and D-140 does not exist.
      return { ok: false, error: `supersededBy "${supersededBy}" does not resolve to an existing decision` };
    }
  }

  const dir = join(projectPath, AXME_CODE_DIR, "decisions");
  const source = findDecisionFile(dir, decision.id);
  if (!source) return { ok: false, error: `Decision file for ${decision.id} not found in ${dir}` };

  let raw: string;
  try { raw = readFileSync(source, "utf-8"); } catch (e: any) {
    return { ok: false, error: `Cannot read ${source}: ${e?.message ?? e}` };
  }

  const now = new Date().toISOString();
  let stamped = setFrontmatterValue(raw, "status", supersededBy ? "superseded" : "revoked");
  stamped = supersededBy
    ? setFrontmatterValue(stamped, "supersededBy", supersededBy)
    : setFrontmatterValue(setFrontmatterValue(stamped, "revokedAt", now), "revokedReason", oneLine(reason));
  stamped = setFrontmatterValue(stamped, "archivedAt", now);
  stamped = setFrontmatterValue(stamped, "archivedReason", oneLine(reason));

  const destDir = join(archiveRoot(projectPath), "decisions");
  ensureDir(destDir);
  const base = source.slice(source.lastIndexOf("/") + 1).replace(/\.md$/, "");
  const dest = uniquePath(destDir, base);

  atomicWrite(dest, stamped);
  try { unlinkSync(source); } catch (e: any) {
    return { ok: false, error: `Archived copy written to ${dest} but original could not be removed: ${e?.message ?? e}` };
  }
  // The index still lists the archived id otherwise, and every later
  // get-by-id would resolve to a file that is no longer there.
  try { rebuildDecisionIndex(projectPath); } catch {}
  return { ok: true, archivedTo: dest };
}

/** Restore an archived entry by moving its file back. Used by `--undo` flows. */
export function listArchived(projectPath: string): { memories: string[]; decisions: string[] } {
  const root = archiveRoot(projectPath);
  const memories: string[] = [];
  for (const sub of ["feedback", "patterns"]) {
    const dir = join(root, "memory", sub);
    if (!pathExists(dir)) continue;
    try {
      for (const f of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
        memories.push(join(dir, f));
      }
    } catch {}
  }
  const decisions: string[] = [];
  const ddir = join(root, "decisions");
  if (pathExists(ddir)) {
    try {
      for (const f of readdirSync(ddir).filter(f => f.endsWith(".md")).sort()) decisions.push(join(ddir, f));
    } catch {}
  }
  return { memories, decisions };
}

// --- Helpers ---

/** Never overwrite inside the archive — an archived entry is evidence. */
function uniquePath(dir: string, base: string): string {
  let candidate = join(dir, `${base}.md`);
  for (let n = 2; pathExists(candidate) && n <= 999; n++) {
    candidate = join(dir, `${base}-${n}.md`);
  }
  return candidate;
}

function findDecisionFile(dir: string, id: string): string | null {
  if (!pathExists(dir)) return null;
  try {
    const match = readdirSync(dir).find(f => f.startsWith(`${id}-`) && f.endsWith(".md"));
    return match ? join(dir, match) : null;
  } catch {
    return null;
  }
}

/** Frontmatter is line-based — a reason with newlines would corrupt the file. */
function oneLine(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Fold several memories into one.
 *
 * Split of responsibility: the AGENT composes the merged text, because
 * deciding which unique detail from each loser is worth keeping is judgment
 * that no heuristic does well. This function does only the file work —
 * rewrite the survivor, archive the rest, keep everything reversible.
 *
 * `into` must survive with the caller's text rather than a concatenation:
 * gluing four descriptions together produces exactly the overlong entry the
 * format contract exists to prevent.
 */
export function mergeMemories(
  projectPath: string,
  into: string,
  from: string[],
  merged: { description?: string; body?: string },
): { ok: boolean; error?: string; archived: string[]; slug?: string } {
  const survivor = getMemory(projectPath, into);
  if (!survivor) return { ok: false, error: `Memory "${into}" not found`, archived: [] };

  const losers = from.filter(s => s !== into);
  const missing = losers.filter(s => !getMemory(projectPath, s));
  if (missing.length > 0) {
    // Refuse the whole operation rather than half-merge: a partial merge
    // leaves the survivor claiming content that was never folded in.
    return { ok: false, error: `Not found: ${missing.join(", ")}`, archived: [] };
  }

  const updated: Memory = {
    ...survivor,
    ...(merged.description !== undefined ? { description: merged.description } : {}),
    ...(merged.body !== undefined ? { body: merged.body } : {}),
  };
  const outcome = saveMemory(projectPath, updated);

  const archived: string[] = [];
  for (const slug of losers) {
    const r = archiveMemory(projectPath, slug, `merged into ${into}`);
    if (r.ok) archived.push(slug);
  }
  return { ok: true, archived, slug: outcome.slug };
}
