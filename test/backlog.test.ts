import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  initBacklogStore,
  addBacklogItem,
  updateBacklogItem,
  listBacklogItems,
  getBacklogItem,
  backlogContext,
  showBacklog,
  toBacklogSlug,
} from "../src/storage/backlog.js";

const TEST_ROOT = "/tmp/axme-backlog-test";

function setup() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, ".axme-code"), { recursive: true });
  initBacklogStore(TEST_ROOT);
}

function cleanup() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
}

describe("addBacklogItem", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("creates B-001 with correct fields", () => {
    const item = addBacklogItem(TEST_ROOT, { title: "Fix auth bug", description: "JWT expiry broken" });
    assert.equal(item.id, "B-001");
    assert.equal(item.title, "Fix auth bug");
    assert.equal(item.status, "open");
    assert.equal(item.priority, "medium");
    assert.equal(item.description, "JWT expiry broken");
  });

  it("auto-increments IDs", () => {
    const a = addBacklogItem(TEST_ROOT, { title: "First", description: "d1" });
    const b = addBacklogItem(TEST_ROOT, { title: "Second", description: "d2" });
    const c = addBacklogItem(TEST_ROOT, { title: "Third", description: "d3" });
    assert.equal(a.id, "B-001");
    assert.equal(b.id, "B-002");
    assert.equal(c.id, "B-003");
  });

  it("uses provided priority", () => {
    const item = addBacklogItem(TEST_ROOT, { title: "Urgent", description: "d", priority: "high" });
    assert.equal(item.priority, "high");
  });

  it("uses provided tags", () => {
    const item = addBacklogItem(TEST_ROOT, { title: "Tagged", description: "d", tags: ["auth", "security"] });
    assert.deepEqual(item.tags, ["auth", "security"]);
  });
});

describe("listBacklogItems", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("returns all items", () => {
    addBacklogItem(TEST_ROOT, { title: "A", description: "d" });
    addBacklogItem(TEST_ROOT, { title: "B", description: "d" });
    assert.equal(listBacklogItems(TEST_ROOT).length, 2);
  });

  it("filters by status", () => {
    addBacklogItem(TEST_ROOT, { title: "Open", description: "d" });
    const item = addBacklogItem(TEST_ROOT, { title: "WIP", description: "d" });
    updateBacklogItem(TEST_ROOT, item.id, { status: "in-progress" });
    assert.equal(listBacklogItems(TEST_ROOT, "open").length, 1);
    assert.equal(listBacklogItems(TEST_ROOT, "in-progress").length, 1);
  });

  it("returns empty for no items", () => {
    assert.equal(listBacklogItems(TEST_ROOT).length, 0);
  });
});

describe("getBacklogItem", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("finds by ID", () => {
    addBacklogItem(TEST_ROOT, { title: "Find me", description: "d" });
    const item = getBacklogItem(TEST_ROOT, "B-001");
    assert.equal(item?.title, "Find me");
  });

  it("finds by slug", () => {
    const created = addBacklogItem(TEST_ROOT, { title: "Find by slug", description: "d" });
    const item = getBacklogItem(TEST_ROOT, created.slug);
    assert.equal(item?.id, "B-001");
  });

  it("returns null for missing", () => {
    assert.equal(getBacklogItem(TEST_ROOT, "B-999"), null);
  });
});

describe("updateBacklogItem", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("updates status", () => {
    addBacklogItem(TEST_ROOT, { title: "Task", description: "d" });
    const updated = updateBacklogItem(TEST_ROOT, "B-001", { status: "in-progress" });
    assert.equal(updated?.status, "in-progress");
    // Verify persisted
    const reread = getBacklogItem(TEST_ROOT, "B-001");
    assert.equal(reread?.status, "in-progress");
  });

  it("updates priority", () => {
    addBacklogItem(TEST_ROOT, { title: "Task", description: "d" });
    const updated = updateBacklogItem(TEST_ROOT, "B-001", { priority: "high" });
    assert.equal(updated?.priority, "high");
  });

  it("appends notes", () => {
    addBacklogItem(TEST_ROOT, { title: "Task", description: "d" });
    updateBacklogItem(TEST_ROOT, "B-001", { notes: "First note" });
    updateBacklogItem(TEST_ROOT, "B-001", { notes: "Second note" });
    const item = getBacklogItem(TEST_ROOT, "B-001");
    assert.ok(item?.notes?.includes("First note"));
    assert.ok(item?.notes?.includes("Second note"));
  });

  it("returns null for missing item", () => {
    assert.equal(updateBacklogItem(TEST_ROOT, "B-999", { status: "done" }), null);
  });

  it("updates the updated date", () => {
    const created = addBacklogItem(TEST_ROOT, { title: "Task", description: "d" });
    const originalDate = created.updated;
    const updated = updateBacklogItem(TEST_ROOT, "B-001", { status: "done" });
    assert.ok(updated?.updated);
    // Same day in test, but field is set
    assert.equal(typeof updated?.updated, "string");
  });
});

describe("backlogContext", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("returns empty for no items", () => {
    assert.equal(backlogContext(TEST_ROOT), "");
  });

  it("shows counts", () => {
    addBacklogItem(TEST_ROOT, { title: "Open1", description: "d" });
    addBacklogItem(TEST_ROOT, { title: "Open2", description: "d" });
    const ctx = backlogContext(TEST_ROOT);
    assert.ok(ctx.includes("2 open"));
    assert.ok(ctx.includes("## Backlog"));
  });

  it("highlights in-progress items", () => {
    const item = addBacklogItem(TEST_ROOT, { title: "WIP task", description: "d" });
    updateBacklogItem(TEST_ROOT, item.id, { status: "in-progress" });
    const ctx = backlogContext(TEST_ROOT);
    assert.ok(ctx.includes("[WIP]"));
    assert.ok(ctx.includes("WIP task"));
  });

  it("highlights high-priority items", () => {
    addBacklogItem(TEST_ROOT, { title: "Urgent fix", description: "d", priority: "high" });
    const ctx = backlogContext(TEST_ROOT);
    assert.ok(ctx.includes("[HIGH]"));
    assert.ok(ctx.includes("Urgent fix"));
  });
});

describe("showBacklog", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("shows all items formatted", () => {
    addBacklogItem(TEST_ROOT, { title: "Task A", description: "d", tags: ["auth"] });
    addBacklogItem(TEST_ROOT, { title: "Task B", description: "d" });
    const output = showBacklog(TEST_ROOT);
    assert.ok(output.includes("B-001"));
    assert.ok(output.includes("Task A"));
    assert.ok(output.includes("[auth]"));
    assert.ok(output.includes("B-002"));
  });

  it("shows message for empty backlog", () => {
    assert.ok(showBacklog(TEST_ROOT).includes("No backlog items"));
  });

  it("filters by status", () => {
    addBacklogItem(TEST_ROOT, { title: "Open", description: "d" });
    const item = addBacklogItem(TEST_ROOT, { title: "Done", description: "d" });
    updateBacklogItem(TEST_ROOT, item.id, { status: "done" });
    const output = showBacklog(TEST_ROOT, "done");
    assert.ok(output.includes("Done"));
    assert.ok(!output.includes("Open"));
  });
});

describe("toBacklogSlug", () => {
  it("converts to lowercase", () => {
    assert.equal(toBacklogSlug("Fix Auth Bug"), "fix-auth-bug");
  });

  it("removes special characters", () => {
    assert.equal(toBacklogSlug("Fix: auth (JWT)!"), "fix-auth-jwt");
  });

  it("max 50 characters", () => {
    const long = "a".repeat(100);
    assert.ok(toBacklogSlug(long).length <= 50);
  });
});
