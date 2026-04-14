/**
 * Regression guard for B-006 / D-121.
 *
 * The Claude Agent SDK resolves its own executable via `import.meta.url`,
 * which is undefined inside the bundled CJS build and crashes with
 * `fileURLToPath(undefined)`. Every direct `sdk.query()` call site must
 * therefore either:
 *   a) build its options through `buildAgentQueryOptions()` (which sets
 *      `pathToClaudeCodeExecutable` via `findClaudePath()`), or
 *   b) import `findClaudePath` and set `pathToClaudeCodeExecutable`
 *      explicitly on its own options object.
 *
 * This test greps every `src/agents/**.ts` file for `sdk.query(` and fails
 * if none of the two helpers are imported. It is static, so it does not
 * require the SDK, the `claude` binary, or any network access.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert";

const AGENTS_DIR = new URL("../src/agents/", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("every src/agents file calling sdk.query imports buildAgentQueryOptions or findClaudePath", () => {
  const files = walk(AGENTS_DIR);
  const offenders: string[] = [];

  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    if (!src.includes("sdk.query(")) continue;

    const hasBuilder = /import\s+[^;]*\bbuildAgentQueryOptions\b[^;]*from\s+["'][^"']*agent-options/.test(src);
    const hasFinder = /import\s+[^;]*\bfindClaudePath\b[^;]*from\s+["'][^"']*agent-options/.test(src);

    if (!hasBuilder && !hasFinder) {
      offenders.push(file.replace(AGENTS_DIR, ""));
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `The following files call sdk.query() but import neither buildAgentQueryOptions ` +
    `nor findClaudePath from utils/agent-options. Without pathToClaudeCodeExecutable ` +
    `the bundled CJS build will crash with fileURLToPath(undefined) (B-006 / D-121):\n` +
    `  ${offenders.join("\n  ")}`,
  );
});

test("session-auditor.ts manual queryOpts include pathToClaudeCodeExecutable", () => {
  const src = readFileSync(new URL("../src/agents/session-auditor.ts", import.meta.url), "utf-8");
  const queryOptsBlocks = src.split("const queryOpts = {").slice(1);
  assert.ok(queryOptsBlocks.length >= 2, "expected at least 2 queryOpts blocks in session-auditor.ts");

  for (const block of queryOptsBlocks) {
    const untilClose = block.slice(0, block.indexOf("};"));
    assert.ok(
      untilClose.includes("pathToClaudeCodeExecutable"),
      `session-auditor.ts queryOpts block missing pathToClaudeCodeExecutable:\n${untilClose.slice(0, 300)}`,
    );
  }
});

test("memory-extractor.ts manual queryOpts include pathToClaudeCodeExecutable", () => {
  const src = readFileSync(new URL("../src/agents/memory-extractor.ts", import.meta.url), "utf-8");
  assert.ok(
    src.includes("pathToClaudeCodeExecutable"),
    "memory-extractor.ts must set pathToClaudeCodeExecutable on its queryOpts",
  );
});
