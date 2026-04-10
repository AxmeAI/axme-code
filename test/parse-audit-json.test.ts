import { parseAuditOutput } from "../src/agents/session-auditor.ts";
import assert from "node:assert";
import { test, describe } from "node:test";

const SESSION_ID = "test-session-123";

describe("parseAuditOutput JSON format", () => {

  test("well-formed JSON — all fields present", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: ["grep \"test\" in /path → no match"],
      memories: [{
        slug: "test-memory",
        type: "feedback",
        title: "Test memory title",
        description: "Test memory description with details",
        keywords: ["test", "memory"],
        scope: "all",
        body: ""
      }],
      decisions: [{
        action: "new",
        title: "Test decision title",
        decision: "This was decided because of reasons. It applies everywhere.",
        reasoning: "",
        enforce: "required",
        scope: "axme-code"
      }],
      safety: [{
        rule_type: "bash_deny",
        value: "rm -rf /",
        scope: "all"
      }],
      oracle_changes: "NO",
      questions: [],
      handoff: {
        stopped_at: "Finished testing",
        summary: "- Tested parser",
        in_progress: "nothing",
        prs: "",
        test_results: "all pass",
        blockers: "none",
        next: "deploy",
        dirty_branches: "none"
      },
      session_summary: "Tested the JSON parser for audit output."
    }) + '\n```';

    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.memories.length, 1);
    assert.strictEqual(r.memories[0].title, "Test memory title");
    assert.strictEqual(r.memories[0].type, "feedback");
    assert.strictEqual(r.memories[0].slug, "test-memory");
    assert.strictEqual(r.decisions.length, 1);
    assert.strictEqual(r.decisions[0].title, "Test decision title");
    assert.strictEqual(r.decisions[0].enforce, "required");
    assert.strictEqual(r.safetyRules.length, 1);
    assert.strictEqual(r.safetyRules[0].ruleType, "bash_deny");
    assert.strictEqual(r.oracleNeedsRescan, false);
    assert.ok(r.handoff);
    assert.strictEqual(r.handoff!.stoppedAt, "Finished testing");
    assert.strictEqual(r.sessionSummary, "Tested the JSON parser for audit output.");
    console.log("  ✓ all fields parsed correctly");
  });

  test("memory with no title but body — fallback recovers", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: [{
        type: "pattern", scope: "axme-code",
        body: "esbuild CJS bundles set import.meta to empty object causing fileURLToPath to throw"
      }],
      decisions: [], safety: [], oracle_changes: "NO", questions: [], handoff: null, session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.memories.length, 1);
    assert.ok(r.memories[0].title.startsWith("esbuild CJS bundles set import.meta"));
    assert.strictEqual(r.memories[0].type, "pattern");
    console.log("  ✓ memory recovered from body");
  });

  test("memory with no title but summary — fallback recovers", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: [{
        type: "feedback", scope: "all",
        summary: "Demo GIF toolchain: asciinema record then agg render with Rust binary from GitHub releases"
      }],
      decisions: [], safety: [], oracle_changes: "NO", questions: [], handoff: null, session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.memories.length, 1);
    assert.ok(r.memories[0].title.startsWith("Demo GIF toolchain"));
    assert.strictEqual(r.memories[0].type, "feedback");
    console.log("  ✓ memory recovered from summary");
  });

  test("decision with no decision but reasoning — fallback recovers", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: [],
      decisions: [{
        action: "new",
        title: "pathToClaudeCodeExecutable must be set explicitly",
        reasoning: "esbuild CJS bundles replace import.meta with {}, so SDK fallback breaks. Must pass explicitly.",
        enforce: "required",
        scope: "axme-code"
      }],
      safety: [], oracle_changes: "NO", questions: [], handoff: null, session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.decisions.length, 1);
    assert.strictEqual(r.decisions[0].title, "pathToClaudeCodeExecutable must be set explicitly");
    assert.ok(r.decisions[0].decision.includes("esbuild CJS"));
    console.log("  ✓ decision recovered from reasoning");
  });

  test("non-array memories (object instead of array) — no crash", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: {}, decisions: [], safety: [],
      oracle_changes: "NO", questions: [], handoff: null, session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.memories.length, 0);
    console.log("  ✓ non-array memories handled gracefully");
  });

  test("non-array decisions/safety/questions — no crash", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: [], decisions: "none", safety: null,
      oracle_changes: "NO", questions: "none", handoff: null, session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.decisions.length, 0);
    assert.strictEqual(r.safetyRules.length, 0);
    assert.strictEqual(r.questions.length, 0);
    console.log("  ✓ non-array fields handled gracefully");
  });

  test("JSON without code fence — raw braces", () => {
    const output = JSON.stringify({
      dedup_check: [], memories: [{
        slug: "raw-json", type: "feedback", title: "Raw JSON works",
        description: "Parser finds JSON without fences", keywords: ["raw"], scope: "all", body: ""
      }],
      decisions: [], safety: [], oracle_changes: "NO", questions: [], handoff: null, session_summary: null
    });
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.memories.length, 1);
    assert.strictEqual(r.memories[0].title, "Raw JSON works");
    console.log("  ✓ raw JSON (no code fence) parsed");
  });

  test("JSON with preamble text before fence", () => {
    const output = 'Here are my findings:\n\n```json\n' + JSON.stringify({
      dedup_check: [], memories: [], decisions: [{
        action: "new", title: "Test preamble", decision: "Works with preamble text.",
        enforce: "advisory", scope: "all"
      }],
      safety: [], oracle_changes: "NO", questions: [], handoff: null, session_summary: null
    }) + '\n```\n\nThat is all.';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.decisions.length, 1);
    assert.strictEqual(r.decisions[0].title, "Test preamble");
    console.log("  ✓ JSON with preamble text parsed");
  });

  test("scope as array vs string — both work", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: [{
        slug: "scope-array", type: "feedback", title: "Array scope",
        description: "Test", keywords: ["test"], scope: ["axme-code", "axme-cloud"], body: ""
      }, {
        slug: "scope-string", type: "pattern", title: "String scope",
        description: "Test", keywords: ["test"], scope: "all", body: ""
      }],
      decisions: [], safety: [], oracle_changes: "NO", questions: [], handoff: null, session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.memories.length, 2);
    assert.deepStrictEqual(r.memories[0].scope, ["axme-code", "axme-cloud"]);
    assert.deepStrictEqual(r.memories[1].scope, ["all"]);
    console.log("  ✓ scope as array and string both work");
  });

  test("oracle_changes YES triggers rescan", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: [], decisions: [], safety: [],
      oracle_changes: "YES new dependency @anthropic-ai/sdk added",
      questions: [], handoff: null, session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.oracleNeedsRescan, true);
    console.log("  ✓ oracle_changes YES detected");
  });

  test("completely invalid output — returns empty result", () => {
    const r = parseAuditOutput("This is not JSON at all, just random text from the LLM.", SESSION_ID);
    assert.strictEqual(r.memories.length, 0);
    assert.strictEqual(r.decisions.length, 0);
    assert.strictEqual(r.handoff, null);
    console.log("  ✓ invalid output returns empty result without crash");
  });

  test("memory with invalid type dropped", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: [{
        slug: "bad-type", type: "observation", title: "Bad type",
        description: "Should be dropped", keywords: [], scope: "all", body: ""
      }],
      decisions: [], safety: [], oracle_changes: "NO", questions: [], handoff: null, session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.memories.length, 0);
    console.log("  ✓ invalid memory type dropped");
  });

  test("decision supersede with supersedes field", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: [],
      decisions: [{
        action: "supersede", title: "New approach replaces old",
        decision: "We now do Y instead of X.", enforce: "required",
        scope: "axme-code", supersedes: "D-042"
      }],
      safety: [], oracle_changes: "NO", questions: [], handoff: null, session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.decisions.length, 1);
    assert.deepStrictEqual((r.decisions[0] as any).supersedes, ["D-042"]);
    assert.strictEqual((r.decisions[0] as any)._action, "supersede");
    console.log("  ✓ supersede decision parsed correctly");
  });

  test("safety with missing rule_type dropped", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: [], decisions: [],
      safety: [{ value: "some command", scope: "all" }],
      oracle_changes: "NO", questions: [], handoff: null, session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.safetyRules.length, 0);
    console.log("  ✓ safety without rule_type dropped");
  });

  test("handoff null when no meaningful content", () => {
    const output = '```json\n' + JSON.stringify({
      dedup_check: [], memories: [], decisions: [], safety: [],
      oracle_changes: "NO", questions: [],
      handoff: { stopped_at: "", summary: "", in_progress: "", prs: "", test_results: "", blockers: "", next: "", dirty_branches: "" },
      session_summary: null
    }) + '\n```';
    const r = parseAuditOutput(output, SESSION_ID);
    assert.strictEqual(r.handoff, null);
    console.log("  ✓ empty handoff fields result in null");
  });
});
