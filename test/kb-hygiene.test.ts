import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeSlug, transliterate, isDegenerateSlug } from "../src/utils/slug.js";
import { stripLeakedMarkup, stripLeakedMarkupFromRecord, hasLeakedMarkup, sanitizeFields } from "../src/utils/sanitize.js";
import { paginateSections } from "../src/utils/pagination.js";
import { runKbDoctor, loadedLayer, setFrontmatterValue, frontmatterValue } from "../src/storage/kb-doctor.js";
import { archiveMemory, archiveDecision, mergeMemories } from "../src/storage/archive.js";
import { saveDecisionTool, MetaDecisionRejected } from "../src/tools/decision-tools.js";
import { formatKbAuditReport } from "../src/agents/kb-auditor.js";
import { checkOverrun, findDuplicateCandidates } from "../src/storage/save-feedback.js";
import { readConfig, writeConfig } from "../src/storage/config.js";
import { initMemoryStore, saveMemory, toMemorySlug, getMemory } from "../src/storage/memory.js";
import { initDecisionStore, addDecision, getDecision, toSlug, listDecisions } from "../src/storage/decisions.js";
import { DEFAULT_PROJECT_CONFIG } from "../src/types.js";

let ROOT: string;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "axme-hygiene-"));
});
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// --- Slug ---

describe("slug generation", () => {
  it("transliterates Cyrillic instead of collapsing to empty", () => {
    // The original implementation produced "" here, which wrote the file as
    // bare ".md" and let the next such title overwrite it.
    assert.equal(makeSlug("Перекат даты"), "perekat-daty");
    assert.equal(makeSlug("Ловушка watchdog при рестарте"), "lovushka-watchdog-pri-restarte");
  });

  it("never returns an empty slug, whatever the script", () => {
    for (const title of ["日本語のみ", "🎉🎉🎉", "!!!", "   ", "…"]) {
      const slug = makeSlug(title);
      assert.notEqual(slug, "", `empty slug for ${JSON.stringify(title)}`);
      assert.ok(/[a-z]/.test(slug), `unsearchable slug ${slug} for ${JSON.stringify(title)}`);
    }
  });

  it("gives different unmappable titles different slugs", () => {
    assert.notEqual(makeSlug("日本語"), makeSlug("中文"));
  });

  it("prefixes degenerate digit-only slugs", () => {
    assert.equal(makeSlug("16-07", 60, "memory"), "memory-16-07");
    assert.equal(makeSlug("3", 60, "memory"), "memory-3");
    assert.ok(!isDegenerateSlug(makeSlug("100", 60, "memory")));
  });

  it("is stable — the same title always yields the same slug", () => {
    assert.equal(makeSlug("Перекат даты"), makeSlug("Перекат даты"));
  });

  it("strips diacritics from Latin titles", () => {
    assert.equal(transliterate("Café Naïve"), "cafe naive");
  });

  it("never leaves a trailing hyphen after truncation", () => {
    const slug = makeSlug("aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffff", 50);
    assert.ok(!slug.endsWith("-"), slug);
  });
});

// --- Sanitize ---

describe("leaked tool-call markup", () => {
  const LEAKED = 'Watchdog flaps on rollover.</description>\n<parameter name="keywords">["bf_live"]';

  it("cuts everything from the first stray tag onward", () => {
    const r = stripLeakedMarkup(LEAKED);
    assert.equal(r.changed, true);
    assert.equal(r.text, "Watchdog flaps on rollover.");
  });

  it("leaves ordinary prose untouched", () => {
    const clean = "Use <Foo /> in JSX and compare a < b in the guard.";
    const r = stripLeakedMarkup(clean);
    assert.equal(r.changed, false);
    assert.equal(r.text, clean);
  });

  it("detects without mutating", () => {
    assert.equal(hasLeakedMarkup(LEAKED), true);
    assert.equal(hasLeakedMarkup("plain text"), false);
  });

  it("record-level stripping keeps content after the frame", () => {
    const record = 'Rule text.</description>\n<parameter name="keywords">["a"]</parameter>\n</invoke>\n\n## Details\n\nkept';
    const r = stripLeakedMarkupFromRecord(record);
    assert.equal(r.changed, true);
    assert.ok(r.text.includes("Rule text."));
    assert.ok(r.text.includes("## Details"));
    assert.ok(r.text.includes("kept"));
    assert.ok(!r.text.includes("<parameter"));
  });

  it("field-level stripping still cuts to the end (a field has no legitimate tail)", () => {
    const r = stripLeakedMarkup('Rule text.</description>\n<parameter name="keywords">["a"]');
    assert.equal(r.text, "Rule text.");
  });

  it("reports which fields it cleaned", () => {
    const { record, cleaned } = sanitizeFields(
      { title: "fine", description: LEAKED, body: "also fine" },
      ["title", "description", "body"],
    );
    assert.deepEqual(cleaned, ["description"]);
    assert.equal(record.description, "Watchdog flaps on rollover.");
    assert.equal(record.title, "fine");
  });
});

// --- Pagination ---

describe("pagination of oversized sections", () => {
  it("does not strand a small header alone on page 1", () => {
    // The reported bug: axme_memories passed ["## Project Memories", <huge>]
    // and page 1 rendered only the heading.
    const huge = Array.from({ length: 4000 }, (_, i) => `- entry ${i} with some descriptive text`).join("\n");
    const result = paginateSections(["## Project Memories", huge], 1, "axme_memories", {});
    assert.ok(result.totalPages > 1);
    assert.ok(result.text.includes("## Project Memories"));
    // Page 1 must carry real content, not just the heading + footer.
    assert.ok(result.text.length > 1000, `page 1 was ${result.text.length} chars`);
    assert.ok(result.text.includes("- entry 0"));
  });

  it("loses no content across pages", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}`);
    const section = lines.join("\n");
    const total = paginateSections([section], 1, "t", {}).totalPages;
    let seen = "";
    for (let p = 1; p <= total; p++) seen += paginateSections([section], p, "t", {}).text;
    for (const l of ["line-0", "line-1499", "line-2999"]) {
      assert.ok(seen.includes(l), `${l} missing from paginated output`);
    }
  });

  it("still single-pages content that fits", () => {
    const r = paginateSections(["short", "also short"], 1, "t", {});
    assert.equal(r.totalPages, 1);
    assert.equal(r.text, "short\n\nalso short");
  });
});

// --- Config ---

describe("catalog.excerpt_chars config", () => {
  it("round-trips through config.yaml", () => {
    mkdirSync(join(ROOT, ".axme-code"), { recursive: true });
    writeConfig(ROOT, { ...DEFAULT_PROJECT_CONFIG, catalogExcerptChars: 320, kbSizeWarnThreshold: 90 });
    const cfg = readConfig(ROOT);
    assert.equal(cfg.catalogExcerptChars, 320);
    assert.equal(cfg.kbSizeWarnThreshold, 90);
  });

  it("clamps values that would break the catalog", () => {
    mkdirSync(join(ROOT, ".axme-code"), { recursive: true });
    writeConfig(ROOT, { ...DEFAULT_PROJECT_CONFIG, catalogExcerptChars: 2 });
    assert.equal(readConfig(ROOT).catalogExcerptChars, 80);
    writeConfig(ROOT, { ...DEFAULT_PROJECT_CONFIG, catalogExcerptChars: 999999 });
    assert.equal(readConfig(ROOT).catalogExcerptChars, 2000);
  });

  it("defaults when the key is absent (existing projects)", () => {
    mkdirSync(join(ROOT, ".axme-code"), { recursive: true });
    writeFileSync(join(ROOT, ".axme-code", "config.yaml"), "model: x\ncontext:\n  mode: full\n");
    assert.equal(readConfig(ROOT).catalogExcerptChars, 200);
  });
});

// --- Save feedback ---

describe("save-time format feedback", () => {
  it("stays silent when the description fits the budget", () => {
    const notes = checkOverrun({ kind: "memory", loadedText: "short rule", hasBody: false, excerptChars: 200 });
    assert.deepEqual(notes, []);
  });

  it("names the concrete overrun and where the tail should go", () => {
    const notes = checkOverrun({ kind: "memory", loadedText: "x".repeat(500), hasBody: false, excerptChars: 200 });
    assert.ok(notes.length > 0);
    const joined = notes.join(" ");
    assert.ok(joined.includes("500"));
    assert.ok(joined.includes("200"));
    assert.ok(joined.includes("## Details"));
    assert.ok(joined.includes("axme_get_memory"));
  });

  it("finds near-duplicate titles", () => {
    initMemoryStore(ROOT);
    saveMemory(ROOT, {
      slug: toMemorySlug("Verify PR merge status before committing"),
      type: "feedback", title: "Verify PR merge status before committing",
      description: "d", body: "", keywords: [], source: "manual", sessionId: null, date: "2026-01-01",
    });
    const hits = findDuplicateCandidates(ROOT, "memory", "Always verify PR merge status before committing");
    assert.equal(hits.length, 1);
    assert.ok(hits[0].title.includes("Verify PR merge status"));
  });

  it("does not flag unrelated titles", () => {
    initMemoryStore(ROOT);
    saveMemory(ROOT, {
      slug: "a", type: "feedback", title: "Docker images must use pinned tags",
      description: "d", body: "", keywords: [], source: "manual", sessionId: null, date: "2026-01-01",
    });
    assert.deepEqual(findDuplicateCandidates(ROOT, "memory", "Retry npm publish via automation token"), []);
  });
});

// --- loadedLayer ---

describe("loadedLayer measurement", () => {
  it("counts only the text loaded at session start", () => {
    const file = [
      "---", "slug: x", "title: T", "---", "",
      "# T", "",
      "The rule, stated once.", "",
      "## Details", "",
      "Thousands of characters of measurements that cost nothing per session.",
    ].join("\n");
    assert.equal(loadedLayer(file, "## Details"), "The rule, stated once.");
  });

  it("handles a record with no deferred section", () => {
    const file = ["---", "slug: x", "---", "", "# T", "", "Just the rule."].join("\n");
    assert.equal(loadedLayer(file, "## Details"), "Just the rule.");
  });
});

describe("setFrontmatterValue", () => {
  it("replaces an existing key", () => {
    const out = setFrontmatterValue("---\nslug: old\ntitle: T\n---\n\nbody\n", "slug", "new");
    assert.ok(out.includes("slug: new"));
    assert.ok(!out.includes("slug: old"));
    assert.ok(out.includes("title: T"));
  });

  it("does not swallow the next field when the key is empty", () => {
    // Regression: `^slug:\s*.*$` let \s* cross the newline, so replacing an
    // empty `slug:` deleted the `type:` line under it — and a memory with no
    // type is dropped by the parser, i.e. silent data loss during repair.
    const raw = "---\nslug: \ntype: pattern\ntitle: T\n---\n\n# T\n\nrule\n";
    const out = setFrontmatterValue(raw, "slug", "fixed");
    assert.ok(out.includes("slug: fixed"));
    assert.ok(out.includes("type: pattern"), out);
    assert.ok(out.includes("title: T"), out);
  });

  it("reads an empty key as empty, not as the next line", () => {
    const raw = "---\nslug: \ntype: pattern\n---\n";
    assert.equal(frontmatterValue(raw, "slug"), "");
    assert.equal(frontmatterValue(raw, "type"), "pattern");
  });

  it("inserts a missing key", () => {
    const out = setFrontmatterValue("---\ntitle: T\n---\n\nbody\n", "archivedAt", "2026-08-18");
    assert.ok(out.includes("archivedAt: 2026-08-18"));
    assert.ok(out.includes("title: T"));
  });
});

// --- KB Doctor ---

describe("kb-doctor", () => {
  function writeMemoryFile(name: string, frontmatter: string, body: string): string {
    const dir = join(ROOT, ".axme-code", "memory", "patterns");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`);
    return path;
  }

  it("finds a memory written as bare .md", () => {
    writeMemoryFile(".md", "slug: \ntype: pattern\ntitle: Перекат даты\nsource: session\ndate: 2026-01-01\nkeywords: \nsessionId: ", "# Перекат даты\n\nrule");
    const report = runKbDoctor(ROOT);
    assert.equal(report.defects.filter(d => d.kind === "empty-slug").length, 1);
  });

  it("repairs it into a real transliterated filename", () => {
    writeMemoryFile(".md", "slug: \ntype: pattern\ntitle: Перекат даты\nsource: session\ndate: 2026-01-01\nkeywords: \nsessionId: ", "# Перекат даты\n\nrule");
    const report = runKbDoctor(ROOT, { fix: true });
    assert.equal(report.fixed.filter(d => d.kind === "empty-slug").length, 1);

    const dir = join(ROOT, ".axme-code", "memory", "patterns");
    const files = readdirSync(dir);
    assert.ok(!files.includes(".md"), "bare .md still present");
    assert.ok(files.includes("perekat-daty.md"), files.join(","));
    // Frontmatter must agree with the new filename, or the next scan flags it.
    const repaired = readFileSync(join(dir, "perekat-daty.md"), "utf-8");
    assert.ok(repaired.includes("slug: perekat-daty"));
    // And every OTHER field must survive the rewrite — a repair that drops
    // `type:` makes the record unparseable, which is worse than the defect.
    assert.ok(repaired.includes("type: pattern"), repaired);
    assert.ok(repaired.includes("title: Перекат даты"), repaired);
    assert.ok(repaired.includes("rule"), repaired);
  });

  it("is idempotent — a second --fix pass changes nothing", () => {
    writeMemoryFile(".md", "slug: \ntype: pattern\ntitle: Перекат даты\nsource: session\ndate: 2026-01-01\nkeywords: \nsessionId: ", "# Перекат даты\n\nrule");
    runKbDoctor(ROOT, { fix: true });
    const second = runKbDoctor(ROOT, { fix: true });
    assert.equal(second.fixed.length, 0);
    assert.equal(second.defects.filter(d => d.autoFixable).length, 0);
  });

  it("finds and strips leaked tool-call markup", () => {
    const p = writeMemoryFile("leaky.md", "slug: leaky\ntype: pattern\ntitle: Leaky\nsource: session\ndate: 2026-01-01\nkeywords: \nsessionId: ",
      '# Leaky\n\nWatchdog flaps.</description>\n<parameter name="keywords">["bf_live"]');
    assert.equal(runKbDoctor(ROOT).defects.filter(d => d.kind === "leaked-markup").length, 1);
    runKbDoctor(ROOT, { fix: true });
    const after = readFileSync(p, "utf-8");
    assert.ok(!after.includes("</description>"));
    assert.ok(!after.includes("<parameter"));
    assert.ok(after.includes("Watchdog flaps."));
  });

  it("preserves the deferred section below a leaked frame", () => {
    // The shape found in the wild: the leak sits at the END of the
    // description, with "## Details" directly under it. A cut-to-end repair
    // would delete the very layer this release exists to protect.
    const p = writeMemoryFile("leaky-with-details.md",
      "slug: leaky-with-details\ntype: pattern\ntitle: Leaky\nsource: session\ndate: 2026-01-01\nkeywords: \nsessionId: ",
      '# Leaky\n\nRun npm whoami before npm publish.</description>\n<parameter name="keywords">["release", "npm"]</parameter>\n</invoke>\n\n## Details\n\nv0.2.7 took 5 retries; npm auth was missing.');

    runKbDoctor(ROOT, { fix: true });
    const after = readFileSync(p, "utf-8");

    assert.ok(!after.includes("</description>"), after);
    assert.ok(!after.includes("<parameter"), after);
    assert.ok(!after.includes("</invoke>"), after);
    assert.ok(after.includes("Run npm whoami before npm publish."), after);
    // The whole point: the deferred layer survives.
    assert.ok(after.includes("## Details"), after);
    assert.ok(after.includes("v0.2.7 took 5 retries"), after);
  });

  it("flags a description that overruns the catalog budget, but does not rewrite it", () => {
    writeMemoryFile("long.md", "slug: long\ntype: pattern\ntitle: Long\nsource: session\ndate: 2026-01-01\nkeywords: \nsessionId: ",
      `# Long\n\n${"x".repeat(600)}`);
    const report = runKbDoctor(ROOT, { fix: true });
    const overlong = report.defects.filter(d => d.kind === "overlong");
    assert.equal(overlong.length, 1);
    assert.equal(overlong[0].autoFixable, false);
    // Content untouched — shortening needs judgment, which is audit-kb's job.
    assert.ok(readFileSync(join(ROOT, ".axme-code", "memory", "patterns", "long.md"), "utf-8").includes("x".repeat(600)));
  });

  it("reports a clean base as clean", () => {
    writeMemoryFile("fine.md", "slug: fine\ntype: pattern\ntitle: Fine\nsource: session\ndate: 2026-01-01\nkeywords: \nsessionId: ", "# Fine\n\nA short rule.");
    assert.deepEqual(runKbDoctor(ROOT).defects, []);
  });
});

// --- Archive ---

describe("archival", () => {
  it("moves a memory into archive/ and removes it from the live store", () => {
    initMemoryStore(ROOT);
    saveMemory(ROOT, {
      slug: "doomed", type: "pattern", title: "Doomed", description: "d",
      body: "", keywords: [], source: "manual", sessionId: null, date: "2026-01-01",
    });
    const r = archiveMemory(ROOT, "doomed", "handoff snapshot, does not carry forward");
    assert.equal(r.ok, true);
    assert.equal(getMemory(ROOT, "doomed"), null);
    assert.ok(existsSync(r.archivedTo!));
    const archived = readFileSync(r.archivedTo!, "utf-8");
    assert.ok(archived.includes("archivedReason: handoff snapshot"));
    assert.ok(archived.includes("Doomed"));
  });

  it("refuses a slug that does not exist", () => {
    initMemoryStore(ROOT);
    const r = archiveMemory(ROOT, "nope", "x");
    assert.equal(r.ok, false);
    assert.ok(r.error!.includes("not found"));
  });

  it("marks a decision superseded before moving it", () => {
    initDecisionStore(ROOT);
    const older = addDecision(ROOT, {
      slug: toSlug("Old rule"), title: "Old rule", decision: "d", reasoning: "r",
      date: "2026-01-01", source: "manual", sessionId: null, enforce: "required",
    });
    const newer = addDecision(ROOT, {
      slug: toSlug("New rule"), title: "New rule", decision: "d", reasoning: "r",
      date: "2026-02-01", source: "manual", sessionId: null, enforce: "required",
    });

    const r = archiveDecision(ROOT, older.id, "covered by the newer rule", newer.id);
    assert.equal(r.ok, true);
    const archived = readFileSync(r.archivedTo!, "utf-8");
    assert.ok(archived.includes("status: superseded"));
    assert.ok(archived.includes(`supersededBy: ${newer.id}`));
    assert.equal(getDecision(ROOT, older.id), null);
    assert.ok(getDecision(ROOT, newer.id));
  });

  it("records a revocation when nothing replaces the decision", () => {
    initDecisionStore(ROOT);
    const d = addDecision(ROOT, {
      slug: toSlug("Obsolete rule"), title: "Obsolete rule", decision: "d", reasoning: "r",
      date: "2026-01-01", source: "manual", sessionId: null, enforce: "advisory",
    });
    const r = archiveDecision(ROOT, d.id, "the subsystem was deleted in PR #99");
    assert.equal(r.ok, true);
    const archived = readFileSync(r.archivedTo!, "utf-8");
    assert.ok(archived.includes("status: revoked"));
    assert.ok(archived.includes("revokedReason: the subsystem was deleted in PR #99"));
  });

  it("refuses a supersededBy that does not resolve", () => {
    initDecisionStore(ROOT);
    const d = addDecision(ROOT, {
      slug: toSlug("Some rule"), title: "Some rule", decision: "d", reasoning: "r",
      date: "2026-01-01", source: "manual", sessionId: null, enforce: null,
    });
    const r = archiveDecision(ROOT, d.id, "x", "D-999");
    assert.equal(r.ok, false);
    assert.ok(r.error!.includes("D-999"));
    // The decision must still be live — a refused archival changes nothing.
    assert.ok(getDecision(ROOT, d.id));
  });

  it("never overwrites inside the archive", () => {
    initMemoryStore(ROOT);
    for (const desc of ["first", "second"]) {
      saveMemory(ROOT, {
        slug: "recurring", type: "pattern", title: "Recurring", description: desc,
        body: "", keywords: [], source: "manual", sessionId: null, date: "2026-01-01",
      });
      const r = archiveMemory(ROOT, "recurring", "cleanup");
      assert.equal(r.ok, true);
    }
    const dir = join(ROOT, ".axme-code", "archive", "memory", "patterns");
    assert.equal(readdirSync(dir).length, 2, readdirSync(dir).join(","));
  });
});

// --- audit-kb reporting ---

describe("audit-kb report", () => {
  const base = {
    decisionsBefore: 87, decisionsAfter: 87, memoriesBefore: 126, memoriesAfter: 126,
    compacted: 0, removed: 0, added: 0,
    loadedBytesBefore: 120_000, loadedBytesAfter: 120_000,
    overlongAfter: 40, backupPath: "/tmp/kb_backup.tar.gz", dryRun: false,
    costUsd: 0.42, durationMs: 240_000, agentSummary: "I analysed everything and concluded...",
  };

  it("calls a zero-change run a FAILED pass, not a success", () => {
    // The exact scenario this rewrite exists for: four minutes of correct
    // analysis, zero bytes written, exit 0, and a user who believes the
    // base was compacted.
    const out = formatKbAuditReport(base);
    assert.ok(out.includes("NO CHANGES WRITTEN"));
    assert.ok(out.includes("FAILED pass"));
    assert.ok(out.includes("/tmp/kb_backup.tar.gz"));
  });

  it("reports the measured before/after, not the agent's claims", () => {
    const out = formatKbAuditReport({
      ...base, memoriesAfter: 90, compacted: 60, removed: 36,
      loadedBytesAfter: 60_000, overlongAfter: 2,
    });
    assert.ok(out.includes("126 → 90"));
    assert.ok(out.includes("60 entries now load less text"));
    assert.ok(out.includes("36 entries left the live store"));
    assert.ok(out.includes("-50%"));
    assert.ok(out.includes("Undo:"));
    assert.ok(!out.includes("NO CHANGES WRITTEN"));
  });

  it("never claims a write in dry-run mode", () => {
    const out = formatKbAuditReport({ ...base, dryRun: true, backupPath: null });
    assert.ok(out.includes("DRY RUN"));
    assert.ok(out.includes("nothing was written"));
    assert.ok(!out.includes("FAILED pass"));
    assert.ok(!out.includes("Undo:"));
  });
});

// --- Meta-decision guard ---

describe("meta-decision guard", () => {
  const input = (title: string) => ({
    title, decision: "d", reasoning: "r", enforce: "required" as const,
  });

  it("refuses a title that is only a pointer between two decision ids", () => {
    initDecisionStore(ROOT);
    for (const t of [
      "D-020 absorbed by D-036",
      "D-092: superseded by D-100",
      "D-7 is covered by D-12",
      "D-024 merged into D-030",
    ]) {
      assert.throws(() => saveDecisionTool(ROOT, input(t)), MetaDecisionRejected, t);
    }
    assert.equal(listDecisions(ROOT).length, 0);
  });

  it("points the agent at the tool that makes the edit instead", () => {
    initDecisionStore(ROOT);
    try {
      saveDecisionTool(ROOT, input("D-020 absorbed by D-036"));
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.ok(err.message.includes("axme_archive_decision"));
      assert.ok(err.message.includes("superseded_by"));
    }
  });

  it("does not block a real decision that merely cites another", () => {
    initDecisionStore(ROOT);
    const r = saveDecisionTool(ROOT, {
      title: "Backlog storage is per-repo, not centralized",
      decision: "Each repo keeps its own backlog. Supersedes D-012, which assumed a single repo.",
      reasoning: "r", enforce: "required",
    });
    assert.equal(r.saved, true);
    assert.equal(listDecisions(ROOT).length, 1);
  });
});

// --- Merge ---

describe("merging memories", () => {
  function mem(slug: string, title: string, description: string) {
    return {
      slug, type: "pattern" as const, title, description, body: "",
      keywords: [], source: "manual" as const, sessionId: null, date: "2026-01-01",
    };
  }

  it("rewrites the survivor and archives the rest", () => {
    initMemoryStore(ROOT);
    saveMemory(ROOT, mem("keep", "Keep this", "original"));
    saveMemory(ROOT, mem("dup-a", "Dup A", "a"));
    saveMemory(ROOT, mem("dup-b", "Dup B", "b"));

    const r = mergeMemories(ROOT, "keep", ["dup-a", "dup-b"], {
      description: "merged rule", body: "specifics from all three",
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.archived.sort(), ["dup-a", "dup-b"]);

    const survivor = getMemory(ROOT, "keep");
    assert.ok(survivor);
    assert.equal(survivor.description, "merged rule");
    assert.equal(survivor.body, "specifics from all three");
    assert.equal(getMemory(ROOT, "dup-a"), null);
    assert.equal(getMemory(ROOT, "dup-b"), null);
  });

  it("refuses the whole merge if any source is missing", () => {
    // A partial merge leaves the survivor claiming content never folded in.
    initMemoryStore(ROOT);
    saveMemory(ROOT, mem("keep", "Keep this", "original"));
    saveMemory(ROOT, mem("dup-a", "Dup A", "a"));

    const r = mergeMemories(ROOT, "keep", ["dup-a", "nope"], { description: "merged" });
    assert.equal(r.ok, false);
    assert.ok(r.error!.includes("nope"));
    assert.equal(getMemory(ROOT, "keep")!.description, "original");
    assert.ok(getMemory(ROOT, "dup-a"));
  });
});
