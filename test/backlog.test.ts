import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  initBacklogStore, addBacklogItem, updateBacklogItem,
  listBacklogItems, getBacklogItem, backlogContext,
  showBacklog, toBacklogSlug,
} from "../src/storage/backlog.js";

const TEST_ROOT = "/tmp/axme-backlog-test";
function setup() { rmSync(TEST_ROOT, { recursive: true, force: true }); mkdirSync(join(TEST_ROOT, ".axme-code"), { recursive: true }); initBacklogStore(TEST_ROOT); }
function cleanup() { rmSync(TEST_ROOT, { recursive: true, force: true }); }

describe("addBacklogItem", () => {
  beforeEach(setup); afterEach(cleanup);
  it("creates B-001", () => { const i = addBacklogItem(TEST_ROOT, { title: "Fix bug", description: "d" }); assert.equal(i.id, "B-001"); assert.equal(i.status, "open"); assert.equal(i.priority, "medium"); });
  it("auto-increments", () => { addBacklogItem(TEST_ROOT, { title: "A", description: "d" }); const b = addBacklogItem(TEST_ROOT, { title: "B", description: "d" }); assert.equal(b.id, "B-002"); });
  it("uses provided priority", () => { const i = addBacklogItem(TEST_ROOT, { title: "U", description: "d", priority: "high" }); assert.equal(i.priority, "high"); });
  it("uses provided tags", () => { const i = addBacklogItem(TEST_ROOT, { title: "T", description: "d", tags: ["auth"] }); assert.deepEqual(i.tags, ["auth"]); });
  it("uses provided scope", () => { const i = addBacklogItem(TEST_ROOT, { title: "S", description: "d", scope: ["all"] }); assert.deepEqual(i.scope, ["all"]); });
  it("timestamps include time and UTC", () => { const i = addBacklogItem(TEST_ROOT, { title: "T", description: "d" }); assert.ok(i.created.includes("UTC")); assert.ok(i.created.includes(":")); });
});

describe("listBacklogItems", () => {
  beforeEach(setup); afterEach(cleanup);
  it("returns all", () => { addBacklogItem(TEST_ROOT, { title: "A", description: "d" }); addBacklogItem(TEST_ROOT, { title: "B", description: "d" }); assert.equal(listBacklogItems(TEST_ROOT).length, 2); });
  it("filters by status", () => { addBacklogItem(TEST_ROOT, { title: "O", description: "d" }); const i = addBacklogItem(TEST_ROOT, { title: "W", description: "d" }); updateBacklogItem(TEST_ROOT, i.id, { status: "in-progress" }); assert.equal(listBacklogItems(TEST_ROOT, "open").length, 1); assert.equal(listBacklogItems(TEST_ROOT, "in-progress").length, 1); });
  it("empty returns []", () => { assert.equal(listBacklogItems(TEST_ROOT).length, 0); });
});

describe("getBacklogItem", () => {
  beforeEach(setup); afterEach(cleanup);
  it("by ID", () => { addBacklogItem(TEST_ROOT, { title: "Find", description: "d" }); assert.equal(getBacklogItem(TEST_ROOT, "B-001")?.title, "Find"); });
  it("by slug", () => { const c = addBacklogItem(TEST_ROOT, { title: "By Slug", description: "d" }); assert.equal(getBacklogItem(TEST_ROOT, c.slug)?.id, "B-001"); });
  it("null for missing", () => { assert.equal(getBacklogItem(TEST_ROOT, "B-999"), null); });
});

describe("updateBacklogItem", () => {
  beforeEach(setup); afterEach(cleanup);
  it("updates status", () => { addBacklogItem(TEST_ROOT, { title: "T", description: "d" }); const u = updateBacklogItem(TEST_ROOT, "B-001", { status: "done" }); assert.equal(u?.status, "done"); assert.equal(getBacklogItem(TEST_ROOT, "B-001")?.status, "done"); });
  it("updates priority", () => { addBacklogItem(TEST_ROOT, { title: "T", description: "d" }); assert.equal(updateBacklogItem(TEST_ROOT, "B-001", { priority: "high" })?.priority, "high"); });
  it("appends notes", () => { addBacklogItem(TEST_ROOT, { title: "T", description: "d" }); updateBacklogItem(TEST_ROOT, "B-001", { notes: "N1" }); updateBacklogItem(TEST_ROOT, "B-001", { notes: "N2" }); const i = getBacklogItem(TEST_ROOT, "B-001"); assert.ok(i?.notes?.includes("N1")); assert.ok(i?.notes?.includes("N2")); });
  it("null for missing", () => { assert.equal(updateBacklogItem(TEST_ROOT, "B-999", { status: "done" }), null); });
  it("updates timestamp with UTC", () => { addBacklogItem(TEST_ROOT, { title: "T", description: "d" }); const u = updateBacklogItem(TEST_ROOT, "B-001", { status: "done" }); assert.ok(u?.updated.includes("UTC")); });
});

describe("backlogContext", () => {
  beforeEach(setup); afterEach(cleanup);
  it("empty returns ''", () => { assert.equal(backlogContext(TEST_ROOT), ""); });
  it("shows counts", () => { addBacklogItem(TEST_ROOT, { title: "A", description: "d" }); addBacklogItem(TEST_ROOT, { title: "B", description: "d" }); const c = backlogContext(TEST_ROOT); assert.ok(c.includes("2 open")); assert.ok(c.includes("## Backlog")); });
  it("highlights WIP", () => { const i = addBacklogItem(TEST_ROOT, { title: "WIP", description: "d" }); updateBacklogItem(TEST_ROOT, i.id, { status: "in-progress" }); assert.ok(backlogContext(TEST_ROOT).includes("[WIP]")); });
  it("highlights HIGH", () => { addBacklogItem(TEST_ROOT, { title: "Urgent", description: "d", priority: "high" }); assert.ok(backlogContext(TEST_ROOT).includes("[HIGH]")); });
});

describe("showBacklog", () => {
  beforeEach(setup); afterEach(cleanup);
  it("shows all formatted", () => { addBacklogItem(TEST_ROOT, { title: "Task A", description: "d", tags: ["auth"] }); const o = showBacklog(TEST_ROOT); assert.ok(o.includes("B-001")); assert.ok(o.includes("[auth]")); });
  it("empty message", () => { assert.ok(showBacklog(TEST_ROOT).includes("No backlog")); });
  it("filters by status", () => { addBacklogItem(TEST_ROOT, { title: "O", description: "d" }); const i = addBacklogItem(TEST_ROOT, { title: "D", description: "d" }); updateBacklogItem(TEST_ROOT, i.id, { status: "done" }); const o = showBacklog(TEST_ROOT, "done"); assert.ok(o.includes("D")); assert.ok(!o.includes(", open,")); });
});

describe("toBacklogSlug", () => {
  it("lowercase", () => { assert.equal(toBacklogSlug("Fix Auth Bug"), "fix-auth-bug"); });
  it("removes special chars", () => { assert.equal(toBacklogSlug("Fix: auth (JWT)!"), "fix-auth-jwt"); });
  it("max 50 chars", () => { assert.ok(toBacklogSlug("a".repeat(100)).length <= 50); });
});

describe("scope persistence", () => {
  beforeEach(setup); afterEach(cleanup);
  it("scope round-trips through file", () => { addBacklogItem(TEST_ROOT, { title: "Scoped", description: "d", scope: ["axme-code"] }); const i = getBacklogItem(TEST_ROOT, "B-001"); assert.deepEqual(i?.scope, ["axme-code"]); });
  it("scope: all round-trips", () => { addBacklogItem(TEST_ROOT, { title: "Global", description: "d", scope: ["all"] }); assert.deepEqual(getBacklogItem(TEST_ROOT, "B-001")?.scope, ["all"]); });
  it("no scope -> undefined", () => { addBacklogItem(TEST_ROOT, { title: "Local", description: "d" }); assert.equal(getBacklogItem(TEST_ROOT, "B-001")?.scope, undefined); });
});
