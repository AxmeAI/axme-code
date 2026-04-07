import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  initDecisionStore,
  addDecision,
  listDecisions,
  getDecision,
  revokeDecision,
  supersedeDecision,
  toSlug,
  showDecisions,
  getDecisionSections,
  decisionsContext,
} from "../src/storage/decisions.js";

const ROOT = "/tmp/axme-decisions-test";

const dec = (title: string, enforce: "required" | "advisory" | null = "required"): any => ({
  slug: toSlug(title),
  title,
  decision: `We decided: ${title}`,
  reasoning: "Because reasons",
  date: "2026-04-07",
  source: "session" as const,
  sessionId: null,
  enforce,
  scope: [],
});

describe("decision store", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    initDecisionStore(ROOT);
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("addDecision creates D-001", () => {
    const d = addDecision(ROOT, dec("First decision"));
    assert.equal(d.id, "D-001");
    assert.equal(d.title, "First decision");
  });

  it("addDecision auto-increments (D-001, D-002, D-003)", () => {
    const d1 = addDecision(ROOT, dec("Decision one"));
    const d2 = addDecision(ROOT, dec("Decision two"));
    const d3 = addDecision(ROOT, dec("Decision three"));
    assert.equal(d1.id, "D-001");
    assert.equal(d2.id, "D-002");
    assert.equal(d3.id, "D-003");
  });

  it("listDecisions returns active only by default", () => {
    addDecision(ROOT, dec("Active one"));
    addDecision(ROOT, dec("Active two"));
    const d3 = addDecision(ROOT, dec("To revoke"));
    revokeDecision(ROOT, d3.id, "no longer needed");
    const active = listDecisions(ROOT);
    assert.equal(active.length, 2);
    assert.ok(active.every(d => !d.status || d.status === "active"));
  });

  it("listDecisions with includeAll returns superseded/revoked too", () => {
    addDecision(ROOT, dec("Keep this"));
    const d2 = addDecision(ROOT, dec("Revoke this"));
    revokeDecision(ROOT, d2.id, "outdated");
    const all = listDecisions(ROOT, { includeAll: true });
    assert.ok(all.length >= 2);
    assert.ok(all.some(d => d.status === "revoked"));
  });

  it("getDecision by ID (exact D-001)", () => {
    addDecision(ROOT, dec("Lookup by ID"));
    const found = getDecision(ROOT, "D-001");
    assert.ok(found);
    assert.equal(found.title, "Lookup by ID");
  });

  it("getDecision by slug", () => {
    const input = dec("Slug lookup test");
    addDecision(ROOT, input);
    const found = getDecision(ROOT, input.slug);
    assert.ok(found);
    assert.equal(found.title, "Slug lookup test");
  });

  it("getDecision returns null for missing", () => {
    const found = getDecision(ROOT, "D-999");
    assert.equal(found, null);
  });

  it("revokeDecision marks as revoked with reason", () => {
    const d = addDecision(ROOT, dec("Will be revoked"));
    const revoked = revokeDecision(ROOT, d.id, "no longer applicable");
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revokedReason, "no longer applicable");
    assert.ok(revoked.revokedAt);
  });

  it("revoked decision not in default listDecisions", () => {
    addDecision(ROOT, dec("Stays active"));
    const d2 = addDecision(ROOT, dec("Gets revoked"));
    revokeDecision(ROOT, d2.id, "bye");
    const active = listDecisions(ROOT);
    assert.equal(active.length, 1);
    assert.equal(active[0].title, "Stays active");
  });

  it("supersedeDecision: old marked superseded, new created with new ID", () => {
    const old = addDecision(ROOT, dec("Old approach"));
    const { oldDecision, newDecision } = supersedeDecision(ROOT, old.id, dec("New approach"));
    assert.equal(oldDecision.status, "superseded");
    assert.equal(oldDecision.supersededBy, newDecision.id);
    assert.ok(newDecision.supersedes);
    assert.ok(newDecision.supersedes!.includes(old.id));
    assert.notEqual(oldDecision.id, newDecision.id);
  });

  it("toSlug: lowercase, alphanumeric+hyphens, max 50", () => {
    assert.equal(toSlug("Hello World!"), "hello-world");
    assert.equal(toSlug("  Special@#Chars  "), "special-chars");
    const long = "x".repeat(100);
    assert.ok(toSlug(long).length <= 50);
  });

  it("showDecisions formatted output", () => {
    addDecision(ROOT, dec("Show this decision"));
    const output = showDecisions(ROOT);
    assert.ok(output.includes("D-001"));
    assert.ok(output.includes("Show this decision"));
  });

  it("showDecisions returns placeholder for empty store", () => {
    const output = showDecisions(ROOT);
    assert.ok(output.includes("No decisions"));
  });

  it("getDecisionSections returns array", () => {
    addDecision(ROOT, dec("Section decision A"));
    addDecision(ROOT, dec("Section decision B"));
    const sections = getDecisionSections(ROOT);
    assert.ok(Array.isArray(sections));
    assert.ok(sections.length >= 2);
    assert.ok(sections.some(s => s.includes("Section decision A")));
    assert.ok(sections.some(s => s.includes("Section decision B")));
  });

  it("getDecisionSections returns placeholder for empty store", () => {
    const sections = getDecisionSections(ROOT);
    assert.ok(sections.some(s => s.includes("No decisions")));
  });

  it("decisionsContext formatted string", () => {
    addDecision(ROOT, dec("Context decision", "required"));
    const ctx = decisionsContext(ROOT);
    assert.ok(ctx.includes("Project Decisions"));
    assert.ok(ctx.includes("Context decision"));
    assert.ok(ctx.includes("required"));
  });

  it("decisionsContext returns empty for no decisions", () => {
    const ctx = decisionsContext(ROOT);
    assert.equal(ctx, "");
  });
});
