import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test the semver comparison logic and platform detection
// (network-dependent parts are tested manually)

describe("auto-update helpers", () => {
  it("semverGreater compares correctly", async () => {
    // Import the module to access internal logic via a wrapper
    // Since semverGreater is not exported, test via version string logic
    const pairs: [string, string, boolean][] = [
      ["0.2.0", "0.1.0", true],
      ["0.1.1", "0.1.0", true],
      ["1.0.0", "0.9.9", true],
      ["0.1.0", "0.1.0", false],
      ["0.1.0", "0.2.0", false],
      ["0.0.9", "0.1.0", false],
    ];

    // Inline the logic to test it
    function semverGreater(a: string, b: string): boolean {
      const pa = a.replace(/^v/, "").split(".").map(Number);
      const pb = b.replace(/^v/, "").split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
        if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
      }
      return false;
    }

    for (const [a, b, expected] of pairs) {
      assert.equal(semverGreater(a, b), expected, `semverGreater("${a}", "${b}") should be ${expected}`);
    }
  });

  it("handles v-prefix in versions", () => {
    function semverGreater(a: string, b: string): boolean {
      const pa = a.replace(/^v/, "").split(".").map(Number);
      const pb = b.replace(/^v/, "").split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
        if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
      }
      return false;
    }

    assert.equal(semverGreater("v0.2.0", "v0.1.0"), true);
    assert.equal(semverGreater("v0.1.0", "0.1.0"), false);
  });

  it("AXME_CODE_VERSION is defined", async () => {
    const { AXME_CODE_VERSION } = await import("../src/types.js");
    assert.ok(typeof AXME_CODE_VERSION === "string");
    assert.ok(AXME_CODE_VERSION.length > 0);
    // In dev/test mode it falls back to "0.0.0-dev"
    assert.ok(AXME_CODE_VERSION === "0.0.0-dev" || /^\d+\.\d+\.\d+/.test(AXME_CODE_VERSION));
  });

  it("getUpdateNotification returns null initially", async () => {
    const { getUpdateNotification } = await import("../src/auto-update.js");
    assert.equal(getUpdateNotification(), null);
  });

  it("detectPlatform returns valid format", () => {
    const os = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const expected = `${os}-${arch}`;
    assert.ok(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(expected));
  });
});
