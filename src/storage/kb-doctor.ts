/**
 * KB Doctor — deterministic storage-defect scan and repair.
 *
 * Everything here is cheap file inspection: no LLM, no network, runs in
 * milliseconds on a 300-entry base. That is the point — the defects it
 * finds are mechanical (a filename, a leaked tag, a length overrun), and
 * paying for an LLM turn to notice them was the reason nobody noticed them
 * for a month.
 *
 * Checks
 *   empty-slug       memory written as bare `.md` — a dotfile, and the next
 *                    such title overwrites it. Real data loss; see
 *                    src/utils/slug.ts.
 *   degenerate-slug  slug of digits only ("3", "16-07") — useless for search.
 *   slug-mismatch    frontmatter `slug:` disagrees with the filename.
 *   leaked-markup    a tool-call XML frame serialized into a text field.
 *   overlong         description/decision longer than the catalog excerpt
 *                    width, so its tail is invisible at session start.
 *   duplicate-title  two entries with the same normalized title.
 *
 * `--fix` repairs the first four. It never repairs `overlong` (that needs
 * judgment about what to move into the body — that is audit-kb's job) and
 * never repairs `duplicate-title` (merging needs judgment too).
 */

import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, pathExists } from "./engine.js";
import { readConfig } from "./config.js";
import { listMemories } from "./memory.js";
import { listDecisions } from "./decisions.js";
import { makeSlug, isDegenerateSlug } from "../utils/slug.js";
import { hasLeakedMarkup, stripLeakedMarkup } from "../utils/sanitize.js";
import { AXME_CODE_DIR } from "../types.js";

export type DefectKind =
  | "empty-slug"
  | "degenerate-slug"
  | "slug-mismatch"
  | "leaked-markup"
  | "overlong"
  | "duplicate-title";

export interface Defect {
  kind: DefectKind;
  /** Absolute path of the offending file. */
  file: string;
  /** One-line human-readable description. */
  detail: string;
  /** True when `--fix` can repair this defect without judgment. */
  autoFixable: boolean;
}

export interface DoctorReport {
  defects: Defect[];
  fixed: Defect[];
  memoriesScanned: number;
  decisionsScanned: number;
  /** Catalog excerpt width the `overlong` check was measured against. */
  excerptChars: number;
}

/**
 * Scan a project's KB storage, optionally repairing the mechanical defects.
 *
 * Safe to call on every session start: with `fix: false` it only reads, and
 * with `fix: true` every repair is idempotent (a renamed file is not renamed
 * again, stripped markup does not re-appear).
 */
export function runKbDoctor(projectPath: string, opts: { fix?: boolean } = {}): DoctorReport {
  const storage = join(projectPath, AXME_CODE_DIR);
  const report: DoctorReport = {
    defects: [], fixed: [], memoriesScanned: 0, decisionsScanned: 0,
    excerptChars: readConfig(projectPath).catalogExcerptChars,
  };
  if (!pathExists(storage)) return report;

  scanMemories(projectPath, storage, report, !!opts.fix);
  scanDecisions(projectPath, storage, report, !!opts.fix);
  return report;
}

// --- Memories ---

function scanMemories(projectPath: string, storage: string, report: DoctorReport, fix: boolean): void {
  const memRoot = join(storage, "memory");
  if (!pathExists(memRoot)) return;

  const titles = new Map<string, string>();

  for (const subdir of ["feedback", "patterns"]) {
    const dir = join(memRoot, subdir);
    if (!pathExists(dir)) continue;
    let files: string[];
    try {
      // readdirSync surfaces dotfiles, which is how the bare `.md` casualties
      // are reachable at all — a shell glob would skip them entirely.
      files = readdirSync(dir).filter(f => f.endsWith(".md")).sort();
    } catch { continue; }

    for (const filename of files) {
      report.memoriesScanned++;
      const path = join(dir, filename);
      let raw: string;
      try { raw = readFileSync(path, "utf-8"); } catch { continue; }

      const title = frontmatterValue(raw, "title");
      const fmSlug = frontmatterValue(raw, "slug");
      const fileSlug = filename.slice(0, -3); // strip ".md"
      const desc = loadedLayer(raw, "## Details");

      // --- slug defects ---
      const wanted = makeSlug(title || fileSlug || "untitled", 60, "memory");
      if (fileSlug === "") {
        const d = defect("empty-slug", path, `written as bare ".md" (title: ${short(title)}) — invisible to shell globs and overwritten by the next such entry; correct slug is "${wanted}"`, true);
        applyOrRecord(d, report, fix, () => renameMemory(dir, wanted, raw, path));
      } else if (isDegenerateSlug(fileSlug)) {
        const d = defect("degenerate-slug", path, `slug "${fileSlug}" has no searchable word; correct slug is "${wanted}"`, true);
        applyOrRecord(d, report, fix, () => renameMemory(dir, wanted, raw, path));
      } else if (fmSlug && fmSlug !== fileSlug) {
        const d = defect("slug-mismatch", path, `frontmatter slug "${fmSlug}" != filename "${fileSlug}"`, true);
        applyOrRecord(d, report, fix, () => {
          // Filename is authoritative: it is what every reader globs by, and
          // rewriting the frontmatter cannot break an existing reference.
          atomicWrite(path, setFrontmatterValue(raw, "slug", fileSlug));
        });
      }

      // --- leaked markup ---
      if (hasLeakedMarkup(raw)) {
        const d = defect("leaked-markup", path, "tool-call XML frame (</description>, <parameter name=…>) serialized into the record", true);
        applyOrRecord(d, report, fix, () => atomicWrite(path, stripLeakedMarkupFromFile(raw)));
      }

      // --- format contract ---
      if (desc.length > report.excerptChars) {
        report.defects.push(defect("overlong", path,
          `description is ${desc.length} chars, catalog renders ${report.excerptChars} — the remaining ${desc.length - report.excerptChars} are invisible at session start; move them into "## Details"`,
          false));
      }

      // --- duplicates ---
      const norm = normalizeTitle(title);
      if (norm) {
        const prev = titles.get(norm);
        if (prev) {
          report.defects.push(defect("duplicate-title", path, `same normalized title as ${prev}`, false));
        } else {
          titles.set(norm, path);
        }
      }
    }
  }
}

/**
 * Rename a memory file to its repaired slug and rewrite the frontmatter to
 * match. Refuses to clobber an existing file: a suffix is appended instead,
 * because the whole point of this repair is that two entries collapsed onto
 * one name and both must survive.
 */
function renameMemory(dir: string, wanted: string, raw: string, oldPath: string): void {
  let target = wanted;
  for (let n = 2; pathExists(join(dir, `${target}.md`)) && n <= 99; n++) target = `${wanted}-${n}`;
  const newPath = join(dir, `${target}.md`);
  if (pathExists(newPath)) {
    throw new Error(`kb-doctor: no free slug for ${oldPath} (tried ${wanted}..${wanted}-99)`);
  }
  // Write-then-unlink, not rename: if the process dies between the two, the
  // content exists twice rather than zero times.
  atomicWrite(newPath, setFrontmatterValue(raw, "slug", target));
  unlinkSync(oldPath);
}

// --- Decisions ---

function scanDecisions(projectPath: string, storage: string, report: DoctorReport, fix: boolean): void {
  const dir = join(storage, "decisions");
  if (!pathExists(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.startsWith("D-") && f.endsWith(".md")).sort();
  } catch { return; }

  const titles = new Map<string, string>();

  for (const filename of files) {
    report.decisionsScanned++;
    const path = join(dir, filename);
    let raw: string;
    try { raw = readFileSync(path, "utf-8"); } catch { continue; }

    const title = frontmatterValue(raw, "title");
    const body = loadedLayer(raw, "## Reasoning");

    if (hasLeakedMarkup(raw)) {
      const d = defect("leaked-markup", path, "tool-call XML frame serialized into the record", true);
      applyOrRecord(d, report, fix, () => atomicWrite(path, stripLeakedMarkupFromFile(raw)));
    }

    if (body.length > report.excerptChars) {
      report.defects.push(defect("overlong", path,
        `decision body is ${body.length} chars, catalog renders ${report.excerptChars} — move the remainder into "## Reasoning"`,
        false));
    }

    const norm = normalizeTitle(title);
    if (norm) {
      const prev = titles.get(norm);
      if (prev) report.defects.push(defect("duplicate-title", path, `same normalized title as ${prev}`, false));
      else titles.set(norm, path);
    }
  }
  void projectPath;
}

// --- Helpers ---

function defect(kind: DefectKind, file: string, detail: string, autoFixable: boolean): Defect {
  return { kind, file, detail, autoFixable };
}

function applyOrRecord(d: Defect, report: DoctorReport, fix: boolean, apply: () => void): void {
  if (fix) {
    try {
      apply();
      report.fixed.push(d);
      return;
    } catch {
      // Repair failed (permissions, races) — report it as outstanding
      // rather than claiming a fix that did not land.
    }
  }
  report.defects.push(d);
}

/**
 * Value of a top-level frontmatter key, or "" when absent.
 *
 * The horizontal-whitespace class matters: `\s*` also matches a newline, so
 * on an EMPTY key ("slug: \ntype: pattern") it would run past the end of the
 * line and return the NEXT field's text as this key's value — and the
 * setter built on the same pattern would delete that field outright.
 */
export function frontmatterValue(raw: string, key: string): string {
  const m = new RegExp(`^${key}:[^\\S\\n]*(.*)$`, "m").exec(raw);
  return m ? m[1].trim() : "";
}

/** Replace (or insert) a frontmatter key while leaving the rest byte-identical. */
export function setFrontmatterValue(raw: string, key: string, value: string): string {
  const re = new RegExp(`^${key}:[^\\S\\n]*.*$`, "m");
  if (re.test(raw)) return raw.replace(re, `${key}: ${value}`);
  // No such key — insert directly after the opening fence.
  if (raw.startsWith("---\n")) return `---\n${key}: ${value}\n` + raw.slice(4);
  return `---\n${key}: ${value}\n---\n\n` + raw;
}

/**
 * The part of a record that is actually loaded into context: everything
 * after the frontmatter and the `# Title` line, up to the deferred-detail
 * heading (`## Details` for memories, `## Reasoning` for decisions).
 *
 * This is the quantity the format contract is about, so it is the quantity
 * the `overlong` check measures — not the file size, which includes the
 * body nobody pays for at session start.
 */
export function loadedLayer(raw: string, stopHeading: string): string {
  let t = raw;
  if (t.startsWith("---\n")) {
    const end = t.indexOf("\n---\n", 4);
    if (end >= 0) t = t.slice(end + 5);
  }
  const stop = t.indexOf("\n" + stopHeading);
  if (stop >= 0) t = t.slice(0, stop);
  t = t.trim();
  // Drop the leading "# Title" line — the catalog renders the title from
  // frontmatter, separately from the excerpt.
  if (t.startsWith("# ")) {
    const nl = t.indexOf("\n");
    t = nl >= 0 ? t.slice(nl + 1) : "";
  }
  return t.trim();
}

/** Strip a leaked tool-call frame from the body of a stored file. */
function stripLeakedMarkupFromFile(raw: string): string {
  const fenceEnd = raw.startsWith("---\n") ? raw.indexOf("\n---\n", 4) : -1;
  if (fenceEnd < 0) return stripLeakedMarkup(raw).text + "\n";
  const head = raw.slice(0, fenceEnd + 5);
  const body = raw.slice(fenceEnd + 5);
  return head + stripLeakedMarkup(body).text + "\n";
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9а-яё ]+/gi, " ").replace(/\s+/g, " ").trim();
}

function short(s: string): string {
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

/**
 * Count of entries whose loaded layer overruns the catalog excerpt width.
 * Used by axme_context to decide whether to nudge the agent about format,
 * without re-running the whole doctor pass.
 */
export function countOverlong(projectPath: string): { memories: number; decisions: number; total: number; excerptChars: number } {
  const excerptChars = readConfig(projectPath).catalogExcerptChars;
  const memories = listMemories(projectPath).filter(m => (m.description ?? "").length > excerptChars).length;
  const decisions = listDecisions(projectPath).filter(d => (d.decision ?? "").length > excerptChars).length;
  return { memories, decisions, total: memories + decisions, excerptChars };
}

/** Render a doctor report as CLI text. */
export function formatDoctorReport(report: DoctorReport, fixMode: boolean): string {
  const lines: string[] = [];
  lines.push(`Scanned ${report.memoriesScanned} memories, ${report.decisionsScanned} decisions (catalog excerpt: ${report.excerptChars} chars).`);
  lines.push("");

  if (report.fixed.length > 0) {
    lines.push(`Fixed ${report.fixed.length}:`);
    for (const d of report.fixed) lines.push(`  [${d.kind}] ${d.file}\n      ${d.detail}`);
    lines.push("");
  }

  if (report.defects.length === 0) {
    lines.push(report.fixed.length > 0 ? "No remaining defects." : "No defects found.");
    return lines.join("\n");
  }

  const byKind = new Map<DefectKind, Defect[]>();
  for (const d of report.defects) {
    const list = byKind.get(d.kind) ?? [];
    list.push(d);
    byKind.set(d.kind, list);
  }

  lines.push(`${report.defects.length} outstanding defect(s):`);
  for (const [kind, list] of byKind) {
    lines.push(`\n${kind} (${list.length}):`);
    // Cap the per-kind listing so a base with 200 overlong entries does not
    // bury the other findings — but say how many were withheld, because a
    // silent cap reads as "that was all of them".
    for (const d of list.slice(0, 10)) lines.push(`  ${d.file}\n      ${d.detail}`);
    if (list.length > 10) lines.push(`  … and ${list.length - 10} more (not listed)`);
  }

  const fixable = report.defects.filter(d => d.autoFixable).length;
  lines.push("");
  if (fixable > 0 && !fixMode) {
    lines.push(`${fixable} of these are auto-fixable — re-run with --fix.`);
  }
  const judgment = report.defects.filter(d => !d.autoFixable).length;
  if (judgment > 0) {
    lines.push(`${judgment} need judgment (overlong / duplicate) — run 'axme-code audit-kb' to compact and merge them.`);
  }
  return lines.join("\n");
}
