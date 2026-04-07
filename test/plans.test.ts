import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import {
  initPlanStore,
  createPlan,
  listPlans,
  getPlan,
  getActivePlans,
  markStepDone,
  markStepInProgress,
  getNextStep,
  plansContext,
  writeHandoff,
  readHandoff,
  handoffContext,
} from "../src/storage/plans.js";

const TEST_ROOT = "/tmp/axme-plans-test";

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  initPlanStore(TEST_ROOT);
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("createPlan", () => {
  it("creates plan with steps, each step has status pending", () => {
    const plan = createPlan(TEST_ROOT, "My Feature", ["Step 1", "Step 2", "Step 3"]);
    assert.ok(plan.id);
    assert.equal(plan.title, "My Feature");
    assert.equal(plan.status, "active");
    assert.equal(plan.steps.length, 3);
    for (const step of plan.steps) {
      assert.equal(step.status, "pending");
    }
  });
});

describe("listPlans", () => {
  it("returns created plans", () => {
    createPlan(TEST_ROOT, "Plan A", ["s1"]);
    createPlan(TEST_ROOT, "Plan B", ["s2"]);
    const plans = listPlans(TEST_ROOT);
    assert.equal(plans.length, 2);
    const titles = plans.map(p => p.title);
    assert.ok(titles.includes("Plan A"));
    assert.ok(titles.includes("Plan B"));
  });
});

describe("getPlan", () => {
  it("by id returns correct plan", () => {
    const created = createPlan(TEST_ROOT, "Specific Plan", ["step a", "step b"]);
    const fetched = getPlan(TEST_ROOT, created.id);
    assert.ok(fetched);
    assert.equal(fetched.title, "Specific Plan");
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.steps.length, 2);
  });
});

describe("getActivePlans", () => {
  it("filters out completed plans", () => {
    const plan1 = createPlan(TEST_ROOT, "Active Plan", ["s1"]);
    const plan2 = createPlan(TEST_ROOT, "Completed Plan", ["s1"]);
    markStepDone(TEST_ROOT, plan2.id, 0); // auto-completes since single step
    const active = getActivePlans(TEST_ROOT);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, plan1.id);
  });
});

describe("markStepDone", () => {
  it("updates step status to done", () => {
    const plan = createPlan(TEST_ROOT, "Step Done Plan", ["s1", "s2"]);
    markStepDone(TEST_ROOT, plan.id, 0);
    const updated = getPlan(TEST_ROOT, plan.id);
    assert.ok(updated);
    assert.equal(updated.steps[0].status, "done");
    assert.equal(updated.steps[1].status, "pending");
  });

  it("auto-completes plan when all steps done", () => {
    const plan = createPlan(TEST_ROOT, "Auto Complete", ["s1", "s2"]);
    markStepDone(TEST_ROOT, plan.id, 0);
    markStepDone(TEST_ROOT, plan.id, 1);
    const updated = getPlan(TEST_ROOT, plan.id);
    assert.ok(updated);
    assert.equal(updated.status, "completed");
  });
});

describe("markStepInProgress", () => {
  it("sets step to in-progress", () => {
    const plan = createPlan(TEST_ROOT, "Progress Plan", ["s1", "s2"]);
    markStepInProgress(TEST_ROOT, plan.id, 0);
    const updated = getPlan(TEST_ROOT, plan.id);
    assert.ok(updated);
    assert.equal(updated.steps[0].status, "in-progress");
  });
});

describe("getNextStep", () => {
  it("returns first pending step", () => {
    const plan = createPlan(TEST_ROOT, "Next Step Plan", ["s1", "s2", "s3"]);
    markStepDone(TEST_ROOT, plan.id, 0);
    const updated = getPlan(TEST_ROOT, plan.id)!;
    const next = getNextStep(updated);
    assert.ok(next);
    assert.equal(next.index, 1);
    assert.equal(next.step.text, "s2");
  });

  it("returns null when all done", () => {
    const plan = createPlan(TEST_ROOT, "All Done Plan", ["s1"]);
    markStepDone(TEST_ROOT, plan.id, 0);
    const updated = getPlan(TEST_ROOT, plan.id)!;
    const next = getNextStep(updated);
    assert.equal(next, null);
  });
});

describe("plansContext", () => {
  it("shows active plans summary", () => {
    createPlan(TEST_ROOT, "Context Plan", ["step alpha", "step beta"]);
    const ctx = plansContext(TEST_ROOT);
    assert.ok(ctx.includes("Active Plans"));
    assert.ok(ctx.includes("Context Plan"));
    assert.ok(ctx.includes("step alpha"));
    assert.ok(ctx.includes("0/2"));
  });
});

describe("handoff", () => {
  it("writeHandoff + readHandoff round-trip", () => {
    const handoff = {
      sessionId: "test-123",
      date: "2026-04-07",
      source: "agent" as const,
      stoppedAt: "Finished feature X",
      inProgress: "Working on feature",
      blockers: "None",
      next: "Deploy to staging",
      dirtyBranches: "None",
    };
    writeHandoff(TEST_ROOT, handoff);
    const result = readHandoff(TEST_ROOT);
    assert.ok(result);
    assert.equal(result.stoppedAt, "Finished feature X");
    assert.equal(result.date, "2026-04-07");
    assert.equal(result.source, "agent");
    assert.equal(result.next, "Deploy to staging");
    assert.ok(result.sessionId?.startsWith("test-123"));
  });

  it("handoffContext formats as markdown with Previous Session Handoff header", () => {
    writeHandoff(TEST_ROOT, {
      sessionId: "ctx-456",
      date: "2026-04-07",
      source: "agent" as const,
      stoppedAt: "Finished feature X",
      inProgress: "Working",
      blockers: "None",
      next: "Deploy to staging",
      dirtyBranches: "None",
    });
    const ctx = handoffContext(TEST_ROOT);
    assert.ok(ctx.includes("## Previous Session Handoff"));
    assert.ok(ctx.includes("Finished feature X"));
  });

  it("readHandoff returns null when no handoff file exists", () => {
    const result = readHandoff(TEST_ROOT);
    assert.equal(result, null);
  });
});

describe("createPlan with multiple plans", () => {
  it("list returns all", () => {
    createPlan(TEST_ROOT, "Plan 1", ["a"]);
    createPlan(TEST_ROOT, "Plan 2", ["b"]);
    createPlan(TEST_ROOT, "Plan 3", ["c"]);
    const plans = listPlans(TEST_ROOT);
    assert.equal(plans.length, 3);
    const titles = plans.map(p => p.title).sort();
    assert.deepEqual(titles, ["Plan 1", "Plan 2", "Plan 3"]);
  });
});
