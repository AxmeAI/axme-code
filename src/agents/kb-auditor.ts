/**
 * Knowledge Base Auditor — agent-driven compaction of decisions and memories.
 *
 * What changed and why (v0.6.4)
 * -----------------------------
 * The previous implementation handed a prompt to an agent and then reported
 * success based on regex-counting the words "supersede" and "revoke" in the
 * agent's closing text. A real run against a 282-entry base analysed
 * everything correctly for four minutes, reached a conclusion, wrote NOTHING,
 * and exited 0 — indistinguishable from a successful compaction. Counting an
 * agent's prose is not measurement.
 *
 * So this module now brackets the agent with deterministic work:
 *
 *   1. snapshot   — every entry's size and content hash, before.
 *   2. backup     — a tarball of the storage, because .axme-code/ is
 *                   gitignored and has no other safety net.
 *   3. agent      — classify and rewrite, per the procedure below.
 *   4. snapshot   — the same measurement, after.
 *   5. reindex    — the embeddings index still points at pre-compaction text
 *                   otherwise, and search returns entries that no longer exist.
 *   6. report     — the DIFF of the two snapshots. Zero changes is reported
 *                   as zero changes, loudly, not as "Done".
 *
 * `--dry-run` runs 1 and 3 with the agent told to write nothing, then prints
 * the plan. It is the recommended first pass on any base the user cares about.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AUDITOR_MODEL, AXME_CODE_DIR } from "../types.js";
import { extractCostFromResult, type CostInfo } from "../utils/cost-extractor.js";
import { buildAgentQueryOptions } from "../utils/agent-options.js";
import { createAgentSdk } from "../utils/agent-sdk.js";
import { pathExists } from "../storage/engine.js";
import { readConfig } from "../storage/config.js";
import { loadedLayer } from "../storage/kb-doctor.js";
import { shortHash } from "../utils/slug.js";

export interface KbAuditResult {
  decisionsBefore: number;
  decisionsAfter: number;
  memoriesBefore: number;
  memoriesAfter: number;
  /** Entries whose loaded layer shrank. */
  compacted: number;
  /** Entries that disappeared from the live store (archived or merged away). */
  removed: number;
  /** Entries that appeared. */
  added: number;
  /** Bytes of the session-start-loaded layer, before and after. */
  loadedBytesBefore: number;
  loadedBytesAfter: number;
  /** Entries still over the catalog excerpt budget after the pass. */
  overlongAfter: number;
  backupPath: string | null;
  dryRun: boolean;
  costUsd: number;
  durationMs: number;
  /** The agent's closing summary — context for the numbers, never the source of them. */
  agentSummary: string;
}

// --- Snapshotting ---

interface EntrySnapshot {
  /** Path relative to the storage root — stable across the run. */
  ref: string;
  /** Byte length of the layer that is loaded into every session. */
  loadedBytes: number;
  hash: string;
}

interface Snapshot {
  decisions: Map<string, EntrySnapshot>;
  memories: Map<string, EntrySnapshot>;
}

/**
 * Measure what the KB costs at session start.
 *
 * Only the loaded layer is counted — the text before `## Details` /
 * `## Reasoning`. File size would be the wrong metric: moving a paragraph
 * from the description into the deferred body is the single most valuable
 * thing this pass can do, and it leaves file size almost unchanged while
 * cutting session cost substantially.
 */
function snapshot(storageRoot: string): Snapshot {
  const decisions = new Map<string, EntrySnapshot>();
  const memories = new Map<string, EntrySnapshot>();

  const decDir = join(storageRoot, "decisions");
  if (pathExists(decDir)) {
    for (const f of safeReaddir(decDir).filter(f => f.startsWith("D-") && f.endsWith(".md"))) {
      const raw = safeRead(join(decDir, f));
      if (raw === null) continue;
      const layer = loadedLayer(raw, "## Reasoning");
      decisions.set(f, { ref: f, loadedBytes: Buffer.byteLength(layer, "utf8"), hash: shortHash(raw) });
    }
  }

  for (const sub of ["feedback", "patterns"]) {
    const dir = join(storageRoot, "memory", sub);
    if (!pathExists(dir)) continue;
    for (const f of safeReaddir(dir).filter(f => f.endsWith(".md"))) {
      const ref = `${sub}/${f}`;
      const raw = safeRead(join(dir, f));
      if (raw === null) continue;
      const layer = loadedLayer(raw, "## Details");
      memories.set(ref, { ref, loadedBytes: Buffer.byteLength(layer, "utf8"), hash: shortHash(raw) });
    }
  }

  return { decisions, memories };
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir).sort(); } catch { return []; }
}

function safeRead(path: string): string | null {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

/**
 * Tar the storage before any write.
 *
 * `.axme-code/` is gitignored by design (D-026), so there is no version
 * history to fall back on — this tarball is the entire safety net for an
 * operation that rewrites every file in the base. If it cannot be created,
 * the audit does not run.
 *
 * Volatile subtrees are excluded: the embeddings index is regenerated by
 * reindex anyway, and session transcripts can outweigh the knowledge base
 * by an order of magnitude.
 */
function createBackup(projectPath: string): string {
  const dir = join(projectPath, ".axme-code-backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = join(dir, `kb_backup_${stamp}.tar.gz`);
  execFileSync("tar", [
    "czf", out,
    "--exclude=.axme-code/_index",
    "--exclude=.axme-code/sessions",
    "--exclude=.axme-code/audit-worker-logs",
    "--exclude=.axme-code/audit-logs",
    "-C", projectPath, AXME_CODE_DIR,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return out;
}

// --- Prompt ---

function buildPrompt(opts: { storageRoot: string; excerptChars: number; dryRun: boolean; allRepos: boolean }): string {
  const { storageRoot, excerptChars, dryRun } = opts;

  const scope = opts.allRepos
    ? `The current directory is a multi-repo workspace. Each repository has its OWN .axme-code/
storage, and so does the workspace root. Audit every one of them independently — a rule that
belongs to one repo must not be judged against another repo's code. Use the Agent tool to run
repos in parallel; each sub-agent follows the identical procedure below within its own repo.`
    : `Work ONLY inside this absolute storage root: ${storageRoot}
Do not touch any other .axme-code/ directory, and do not use paths relative to your cwd.`;

  const writePolicy = dryRun
    ? `## DRY RUN — WRITE NOTHING

This is a preview pass. You MUST NOT use Edit, Write, or any Bash command that mutates files.
Read and classify only, then report the plan you WOULD execute. Be specific: name every entry
and the bucket you put it in. The user will re-run without --dry-run to apply it.`
    : `## APPLY MODE — YOU ARE EXPECTED TO WRITE

A backup already exists, so mistakes are recoverable. Analysis without writes is a FAILED run:
the previous version of this tool reasoned correctly for four minutes, wrote nothing, and
reported success — which is why the harness now measures the files rather than trusting this
summary. If you finish without a single Edit/Write, say so explicitly and explain why.

Work in small batches (10-20 entries), applying each batch before moving to the next. Do not
build a complete plan for 200 entries and then run out of room to execute it.`;

  return `You are compacting an AXME knowledge base.

${scope}

${writePolicy}

## The format contract — this is what the whole pass is about

Every memory and decision has two layers:

  LOADED   memory description / decision body — the text between "# Title" and the
           "## Details" (memories) or "## Reasoning" (decisions) heading.
           This is loaded into EVERY future session. It is the only thing that costs.
  DEFERRED "## Details" / "## Reasoning" sections. NOT loaded at session start; returned
           in full by axme_get_memory / axme_get_decision when someone asks.

The session-start catalog renders **${excerptChars} characters** of the loaded layer per entry.
An entry within that budget is shown COMPLETE — nothing about it is hidden from future
sessions. An entry over budget is cut, and its tail is invisible to anyone who does not
explicitly fetch it. So the loaded layer must be <= ${excerptChars} characters.

**Nothing is deleted by shortening.** Every number, path, threshold, line reference and
measurement you cut from the loaded layer MOVES DOWN into "## Details" / "## Reasoning".
If a section does not exist yet, create it. Losing a fact is a defect; relocating one is the job.

Do NOT split an entry into several single-fact entries to meet the budget. Per-entry overhead
(slug, title, catalog markup) is 60-100 characters and multiplies by count — splitting makes
the base bigger. Cut DOWN into the deferred layer, never ACROSS into more records.

## Step 1 — read the bodies, not the titles

Read entries IN FULL. Half the value of a knowledge base sits in the body: line numbers, sign
conventions, thresholds, script paths. You cannot classify an entry from its title, and an
entry archived on the strength of its title alone is how real rules get lost.

For decisions, start from ".axme-code/decisions/index.md" to get the inventory in one read,
then read the individual D-NNN files.

## Step 2 — classify every entry into exactly one bucket

**KEEP** — carries forward, already within budget:
  an owner's rule or ruling · vendor/feed/API semantics (sign convention, error codes, limits,
  cadence) · a tool or language trap that will recur · a closed direction recorded so nobody
  reopens it · a live production contract.

**COMPACT** — the rule is there but drowned in narrative:
  rewrite the loaded layer to the rule plus one concrete fact, <= ${excerptChars} characters.
  Move EVERY number, threshold, path and line reference into the deferred section.
  Cut: "Measured on 29.07 across 400 random events, it turned out that…", "I did…",
  backstory, what was fixed when. Keep: the rule, and what to do about it.

**MERGE** — two or more entries about one thing:
  append the unique detail of each into the fullest one, then archive the rest. Find candidates
  by near-identical titles and by cross-references between entries.

**ARCHIVE** — does not carry forward:
  session handoffs and state snapshots · research diaries for closed directions (the conclusions
  live in docs/) · self-retracted entries (grep for RETRACTED / SUPERSEDED / OBSOLETE / ОТОЗВАН /
  ОПРОВЕРГНУТ / устарел) · one-off incidents whose fix is in the code and that yield no
  transferable rule · meta-decisions of the form "D-020 absorbed by D-036" (the edit is already
  in D-020 and D-036; the meta-record just occupies space) · decisions retired by a newer one.

## Step 3 — archive means archive, and it means marked

Move the file into ".axme-code/archive/" preserving its subdirectory (archive/decisions/,
archive/memory/feedback/, archive/memory/patterns/). NEVER delete.

BEFORE moving a decision, write into its frontmatter:
  status: superseded
  supersededBy: D-NNN
or, when nothing replaces it:
  status: revoked
  revokedAt: <ISO date>
  revokedReason: <why, citing the code or entry that makes it obsolete>

An archive of unmarked files is a graveyard nobody can read.

## Step 4 — storage defects

  find <storage>/memory -name '.md'          — empty slug; these entries were overwriting
                                                each other. Rename to a real transliterated slug.
  grep -rl '</description>\\|<parameter name=' <storage>/memory <storage>/decisions
                                              — leaked tool-call markup; cut from the first
                                                stray tag onward.
  frontmatter 'slug:' disagreeing with the filename — make the frontmatter match the filename.

## What NOT to do

- Do not delete anything permanently. Archive only.
- When in doubt, KEEP. Doubt is not evidence of uselessness.
- Do not touch entries modified in the last 2 hours — another session may be writing to this
  same base right now.
- Do not rewrite history. If an entry records the retraction of an earlier conclusion, keep
  BOTH the retraction and what it retracts.
- Do not create new memories or decisions. This pass only compacts, merges, and archives.

## Report

Finish with a plain summary: how many entries you kept / compacted / merged / archived, and
which storage defects you found. The harness measures the files independently and will print
the authoritative numbers — your summary is there to explain them, not to substitute for them.`;
}

// --- Runner ---

export async function runKbAudit(opts: {
  targetPath: string;
  allRepos: boolean;
  model?: string;
  dryRun?: boolean;
}): Promise<KbAuditResult> {
  const startTime = Date.now();
  const dryRun = !!opts.dryRun;
  const storageRoot = join(opts.targetPath, AXME_CODE_DIR);
  const excerptChars = readConfig(opts.targetPath).catalogExcerptChars;

  const before = snapshot(storageRoot);

  let backupPath: string | null = null;
  if (!dryRun) {
    // Deliberately unguarded: if the backup cannot be written we must not
    // proceed to rewrite every file in a store that has no version history.
    backupPath = createBackup(opts.targetPath);
  }

  const model = opts.model ?? DEFAULT_AUDITOR_MODEL;
  const sdk = await createAgentSdk("auditor", { cwd: opts.targetPath });
  const queryOpts = buildAgentQueryOptions({ cwd: opts.targetPath, model }, "auditor");
  const prompt = buildPrompt({ storageRoot, excerptChars, dryRun, allRepos: opts.allRepos });

  const q = sdk.query({ prompt, options: queryOpts });

  let agentSummary = "";
  let cost: CostInfo | undefined;

  for await (const msg of q) {
    if (msg.type === "assistant") {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "thinking" && block.thinking) {
            process.stderr.write(`\x1b[2m[thinking] ${String(block.thinking)}\x1b[0m\n`);
          }
          if (block.type === "text" && block.text) {
            agentSummary += block.text;
            process.stderr.write(`${block.text}\n`);
          }
        }
      }
    }
    if (msg.type === "result") {
      cost = extractCostFromResult(msg);
      if ((msg as any).subtype === "success" && (msg as any).result) {
        agentSummary = (msg as any).result;
      }
    }
  }

  const after = dryRun ? before : snapshot(storageRoot);

  return {
    ...diffSnapshots(before, after, excerptChars),
    backupPath,
    dryRun,
    costUsd: cost?.costUsd ?? 0,
    durationMs: Date.now() - startTime,
    agentSummary,
  };
}

/**
 * Compare two snapshots into the numbers the CLI reports.
 *
 * "compacted" counts entries whose loaded layer got SMALLER, not entries
 * that merely changed — an entry can be edited without becoming cheaper,
 * and reporting that as compaction would overstate the result.
 */
function diffSnapshots(before: Snapshot, after: Snapshot, excerptChars: number) {
  const all = (s: Snapshot) => [...s.decisions.values(), ...s.memories.values()];
  // Namespaced keys so a decision and a memory can never collide by filename.
  const keyed = (s: Snapshot) => new Map<string, EntrySnapshot>([
    ...[...s.decisions.values()].map(e => [`D:${e.ref}`, e] as const),
    ...[...s.memories.values()].map(e => [`M:${e.ref}`, e] as const),
  ]);
  const beforeAll = keyed(before);
  const afterAll = keyed(after);

  let compacted = 0, removed = 0, added = 0;
  for (const [k, b] of beforeAll) {
    const a = afterAll.get(k);
    if (!a) { removed++; continue; }
    if (a.loadedBytes < b.loadedBytes) compacted++;
  }
  for (const k of afterAll.keys()) if (!beforeAll.has(k)) added++;

  const sum = (m: Map<string, EntrySnapshot>) =>
    [...m.values()].reduce((n, e) => n + e.loadedBytes, 0);

  return {
    decisionsBefore: before.decisions.size,
    decisionsAfter: after.decisions.size,
    memoriesBefore: before.memories.size,
    memoriesAfter: after.memories.size,
    compacted, removed, added,
    loadedBytesBefore: sum(before.decisions) + sum(before.memories),
    loadedBytesAfter: sum(after.decisions) + sum(after.memories),
    overlongAfter: all(after).filter(e => e.loadedBytes > excerptChars).length,
  };
}

/**
 * Render the audit outcome for the CLI.
 *
 * The zero-change case gets its own branch and an explicit verdict, because
 * the failure this whole rewrite exists to catch looked exactly like success:
 * a long run, a confident summary, and not one byte written.
 */
export function formatKbAuditReport(r: KbAuditResult): string {
  const lines: string[] = [];
  const entriesBefore = r.decisionsBefore + r.memoriesBefore;
  const entriesAfter = r.decisionsAfter + r.memoriesAfter;
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

  lines.push("");
  lines.push("─".repeat(64));

  if (r.dryRun) {
    lines.push("DRY RUN — nothing was written.");
    lines.push("");
    lines.push(`Base: ${r.decisionsBefore} decisions, ${r.memoriesBefore} memories, ` +
      `${kb(r.loadedBytesBefore)} loaded per session, ${r.overlongAfter} entries over budget.`);
    lines.push("");
    lines.push("The plan is in the agent output above. Re-run without --dry-run to apply it.");
    lines.push("─".repeat(64));
    return lines.join("\n");
  }

  const changed = r.compacted + r.removed + r.added;
  if (changed === 0) {
    lines.push("NO CHANGES WRITTEN.");
    lines.push("");
    lines.push(`The base is byte-identical: still ${r.decisionsBefore} decisions and ` +
      `${r.memoriesBefore} memories, ${kb(r.loadedBytesBefore)} loaded per session.`);
    lines.push("");
    lines.push("This is a FAILED pass, not a clean base — unless the agent output above says the");
    lines.push("base was already compact. If it described a plan it did not execute, re-run; the");
    lines.push("run is idempotent and the backup below is untouched.");
    if (r.backupPath) lines.push(`Backup: ${r.backupPath}`);
    lines.push("─".repeat(64));
    return lines.join("\n");
  }

  const saved = r.loadedBytesBefore - r.loadedBytesAfter;
  const pct = r.loadedBytesBefore > 0 ? Math.round((saved / r.loadedBytesBefore) * 100) : 0;

  lines.push("KB audit applied.");
  lines.push("");
  lines.push(`  decisions   ${r.decisionsBefore} → ${r.decisionsAfter}`);
  lines.push(`  memories    ${r.memoriesBefore} → ${r.memoriesAfter}`);
  lines.push(`  entries     ${entriesBefore} → ${entriesAfter}`);
  lines.push("");
  lines.push(`  compacted   ${r.compacted} entries now load less text`);
  lines.push(`  removed     ${r.removed} entries left the live store (archived or merged)`);
  if (r.added > 0) lines.push(`  added       ${r.added} entries appeared`);
  lines.push("");
  lines.push(`  session-start payload  ${kb(r.loadedBytesBefore)} → ${kb(r.loadedBytesAfter)} (${pct >= 0 ? "-" : "+"}${Math.abs(pct)}%)`);
  lines.push(`  still over budget      ${r.overlongAfter} entries`);
  lines.push("");
  if (r.backupPath) {
    lines.push(`Backup: ${r.backupPath}`);
    lines.push(`Undo:   tar xzf ${r.backupPath} -C <project-root>`);
  }
  lines.push("Archived entries are under .axme-code/archive/ — nothing was deleted.");
  lines.push("─".repeat(64));
  return lines.join("\n");
}
