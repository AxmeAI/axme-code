import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mergeDecisions,
  mergeSafetyRules,
  mergeMemories,
} from "../src/storage/workspace-merge.js";

// Inline type definitions (interfaces from types.ts, not importable at runtime)
interface Decision {
  id: string;
  slug: string;
  title: string;
  decision: string;
  reasoning: string;
  date: string;
  source: "init-scan" | "session" | "manual" | "preset";
  sessionId: string | null;
  enforce: "required" | "advisory" | null;
  scope?: string[];
  status?: "active" | "superseded" | "deprecated" | "revoked";
}

interface Memory {
  slug: string;
  type: "feedback" | "pattern";
  title: string;
  description: string;
  keywords: string[];
  source: "init-scan" | "session" | "preset" | "manual";
  sessionId: string | null;
  date: string;
  body: string;
  scope?: string[];
}

interface SafetyRules {
  git: {
    protectedBranches: string[];
    allowForcePush: boolean;
    allowDirectPushToMain: boolean;
    requirePrForMain: boolean;
  };
  bash: {
    allowedPrefixes: string[];
    deniedPrefixes: string[];
    deniedCommands: string[];
  };
  filesystem: {
    readOnlyPaths: string[];
    deniedPaths: string[];
  };
}

function makeDecision(overrides: Partial<Decision> & { id: string; title: string }): Decision {
  return {
    slug: overrides.id,
    decision: "some decision",
    reasoning: "some reason",
    date: "2026-01-01",
    source: "session",
    sessionId: null,
    enforce: null,
    ...overrides,
  };
}

function makeMemory(overrides: Partial<Memory> & { slug: string; title: string }): Memory {
  return {
    type: "feedback",
    description: "desc",
    keywords: [],
    source: "session",
    sessionId: null,
    date: "2026-01-01",
    body: "body",
    ...overrides,
  };
}

function emptySafety(): SafetyRules {
  return {
    git: {
      protectedBranches: [],
      allowForcePush: true,
      allowDirectPushToMain: true,
      requirePrForMain: false,
    },
    bash: {
      allowedPrefixes: [],
      deniedPrefixes: [],
      deniedCommands: [],
    },
    filesystem: {
      readOnlyPaths: [],
      deniedPaths: [],
    },
  };
}

// --- mergeDecisions ---

describe("mergeDecisions", () => {
  it("merges workspace + project, all present in result", () => {
    const ws = [makeDecision({ id: "d1", title: "WS Dec 1" })];
    const proj = [makeDecision({ id: "d2", title: "Proj Dec 2" })];
    const result = mergeDecisions(ws, proj);
    assert.equal(result.length, 2);
    assert.ok(result.some(d => d.id === "d1"));
    assert.ok(result.some(d => d.id === "d2"));
  });

  it("project ID wins on duplicate", () => {
    const ws = [makeDecision({ id: "dup", title: "WS version" })];
    const proj = [makeDecision({ id: "dup", title: "Project version" })];
    const result = mergeDecisions(ws, proj);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "Project version");
  });

  it("empty workspace + non-empty project returns project only", () => {
    const proj = [makeDecision({ id: "p1", title: "Only proj" })];
    const result = mergeDecisions([], proj);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "p1");
  });

  it("empty project + non-empty workspace returns workspace only", () => {
    const ws = [makeDecision({ id: "w1", title: "Only ws" })];
    const result = mergeDecisions(ws, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "w1");
  });
});

// --- mergeSafetyRules ---

describe("mergeSafetyRules", () => {
  it("unions deniedPrefixes", () => {
    const ws = emptySafety();
    ws.bash.deniedPrefixes = ["rm -rf"];
    const proj = emptySafety();
    proj.bash.deniedPrefixes = ["sudo"];
    const result = mergeSafetyRules(ws, proj);
    assert.ok(result.bash.deniedPrefixes.includes("rm -rf"));
    assert.ok(result.bash.deniedPrefixes.includes("sudo"));
  });

  it("unions protectedBranches", () => {
    const ws = emptySafety();
    ws.git.protectedBranches = ["main"];
    const proj = emptySafety();
    proj.git.protectedBranches = ["release"];
    const result = mergeSafetyRules(ws, proj);
    assert.ok(result.git.protectedBranches.includes("main"));
    assert.ok(result.git.protectedBranches.includes("release"));
  });

  it("allowForcePush: false in either results in false (AND)", () => {
    const ws = emptySafety();
    ws.git.allowForcePush = false;
    const proj = emptySafety();
    proj.git.allowForcePush = true;
    const result = mergeSafetyRules(ws, proj);
    assert.equal(result.git.allowForcePush, false);
  });

  it("allowDirectPushToMain: false in either results in false", () => {
    const ws = emptySafety();
    ws.git.allowDirectPushToMain = true;
    const proj = emptySafety();
    proj.git.allowDirectPushToMain = false;
    const result = mergeSafetyRules(ws, proj);
    assert.equal(result.git.allowDirectPushToMain, false);
  });

  it("deniedPaths unioned from both", () => {
    const ws = emptySafety();
    ws.filesystem.deniedPaths = ["/etc/passwd"];
    const proj = emptySafety();
    proj.filesystem.deniedPaths = ["/secret"];
    const result = mergeSafetyRules(ws, proj);
    assert.ok(result.filesystem.deniedPaths.includes("/etc/passwd"));
    assert.ok(result.filesystem.deniedPaths.includes("/secret"));
  });

  it("both empty returns empty result", () => {
    const result = mergeSafetyRules(emptySafety(), emptySafety());
    assert.equal(result.git.protectedBranches.length, 0);
    assert.equal(result.bash.deniedPrefixes.length, 0);
    assert.equal(result.filesystem.deniedPaths.length, 0);
    assert.equal(result.git.allowForcePush, true);
    assert.equal(result.git.allowDirectPushToMain, true);
  });
});

// --- mergeMemories ---

describe("mergeMemories", () => {
  it("merges all memories from both", () => {
    const ws = [makeMemory({ slug: "m1", title: "WS mem" })];
    const proj = [makeMemory({ slug: "m2", title: "Proj mem" })];
    const result = mergeMemories(ws, proj);
    assert.equal(result.length, 2);
    assert.ok(result.some(m => m.slug === "m1"));
    assert.ok(result.some(m => m.slug === "m2"));
  });

  it("project slug wins on duplicate", () => {
    const ws = [makeMemory({ slug: "dup", title: "WS version" })];
    const proj = [makeMemory({ slug: "dup", title: "Project version" })];
    const result = mergeMemories(ws, proj);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "Project version");
  });

  it("no overlap - all preserved", () => {
    const ws = [
      makeMemory({ slug: "a", title: "A" }),
      makeMemory({ slug: "b", title: "B" }),
    ];
    const proj = [
      makeMemory({ slug: "c", title: "C" }),
      makeMemory({ slug: "d", title: "D" }),
    ];
    const result = mergeMemories(ws, proj);
    assert.equal(result.length, 4);
  });
});
