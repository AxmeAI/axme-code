import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOwnAncestorPids, getClaudeCodePid } from "../src/storage/sessions.js";

/**
 * Ancestor-chain ownership matching (Cursor extension fix, 2026-06-11).
 *
 * Hooks record ownerPpid = their grandparent (getClaudeCodePid). Under
 * Claude Code that equals the MCP server's parent; under Cursor it is the
 * server's GRANDparent (cursor-server vs extension host). Ownership checks
 * therefore match against getOwnAncestorPids(), whose first element must be
 * process.ppid so the historical strict-equality behavior is a subset.
 */
describe("getOwnAncestorPids", () => {
  it("starts with process.ppid", () => {
    const chain = getOwnAncestorPids();
    assert.ok(chain.length >= 1, "chain must never be empty");
    assert.equal(chain[0], process.ppid, "chain[0] must be the direct parent");
  });

  it("walks beyond the direct parent where the platform allows", () => {
    const chain = getOwnAncestorPids(4);
    // Test runners are always at least two levels deep (init → shell/runner
    // → node). /proc (Linux) and ps (macOS) both support the walk; a
    // single-element chain there would mean the walk silently broke.
    if (process.platform === "linux" || process.platform === "darwin") {
      assert.ok(chain.length >= 2, `expected >=2 ancestors, got: ${chain.join(",")}`);
    }
  });

  it("returns finite pids > 1 with no duplicates", () => {
    const chain = getOwnAncestorPids(4);
    for (const pid of chain) {
      assert.ok(Number.isFinite(pid) && pid > 1, `bad pid in chain: ${pid}`);
    }
    assert.equal(new Set(chain).size, chain.length, "chain must not contain duplicates");
  });

  it("respects maxDepth", () => {
    assert.ok(getOwnAncestorPids(1).length <= 1);
    assert.ok(getOwnAncestorPids(2).length <= 2);
  });

  it("contains the hook-side owner pid for same-parent layouts (Claude Code invariant)", () => {
    // In a Claude Code layout hooks and the server share one parent, and
    // getClaudeCodePid() from THIS process resolves our grandparent — which
    // must be inside our own ancestor chain. This is exactly the membership
    // check isOwnedMapping() performs in server.ts.
    const chain = new Set(getOwnAncestorPids(4));
    const hookStyleOwner = getClaudeCodePid();
    if (process.platform === "linux") {
      assert.ok(
        chain.has(hookStyleOwner),
        `grandparent ${hookStyleOwner} not in ancestor chain ${[...chain].join(",")}`,
      );
    }
  });
});
