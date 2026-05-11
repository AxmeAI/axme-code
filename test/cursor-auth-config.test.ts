import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Override the home-dir env var so auth-config (which calls os.homedir())
// reads from a sandboxed path. On Windows os.homedir() reads USERPROFILE,
// not HOME — set both for cross-platform safety.
const SANDBOX_HOME = "/tmp/axme-cursor-auth-test-home";
const HOME_VARS = process.platform === "win32" ? ["USERPROFILE", "HOME"] : ["HOME"];
const ORIGINAL: Record<string, string | undefined> = {};
for (const v of HOME_VARS) ORIGINAL[v] = process.env[v];

beforeEach(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  mkdirSync(SANDBOX_HOME, { recursive: true });
  for (const v of HOME_VARS) process.env[v] = SANDBOX_HOME;
});

afterEach(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  for (const v of HOME_VARS) {
    if (ORIGINAL[v] === undefined) delete process.env[v];
    else process.env[v] = ORIGINAL[v];
  }
});

describe("auth.yaml round-trip with cursor_sdk mode", () => {
  it("saveAuthConfig('cursor_sdk') then loadAuthConfig() returns mode + chosenAt", async () => {
    const { saveAuthConfig, loadAuthConfig } = await import("../src/utils/auth-config.js");
    saveAuthConfig("cursor_sdk");
    const loaded = loadAuthConfig();
    assert.ok(loaded);
    assert.equal(loaded!.mode, "cursor_sdk");
    assert.equal(typeof loaded!.chosenAt, "string");
  });

  it("rejects unknown modes from yaml", async () => {
    const { authConfigPath, loadAuthConfig } = await import("../src/utils/auth-config.js");
    mkdirSync(join(SANDBOX_HOME, ".config", "axme-code"), { recursive: true });
    writeFileSync(authConfigPath(), "mode: bogus\nchosenAt: '2026-01-01'\n");
    assert.equal(loadAuthConfig(), null);
  });

  it("accepts the existing modes (subscription, api_key) for backward compat", async () => {
    const { saveAuthConfig, loadAuthConfig } = await import("../src/utils/auth-config.js");
    saveAuthConfig("subscription");
    assert.equal(loadAuthConfig()?.mode, "subscription");
    saveAuthConfig("api_key");
    assert.equal(loadAuthConfig()?.mode, "api_key");
  });
});

describe("cursor.yaml — paste-once API key", () => {
  it("saveCursorApiKey writes to ~/.config/axme-code/cursor.yaml with mode 0600 (POSIX)", async () => {
    const { saveCursorApiKey, cursorApiKeyPath, loadCursorApiKey } =
      await import("../src/utils/auth-config.js");
    saveCursorApiKey("ck-test-1234567890abcdefghijklmnopqrstuv");
    const path = cursorApiKeyPath();
    assert.ok(existsSync(path));
    if (process.platform !== "win32") {
      const stat = statSync(path);
      assert.equal(stat.mode & 0o777, 0o600, "cursor.yaml must be chmod 600");
    }
    assert.equal(loadCursorApiKey(), "ck-test-1234567890abcdefghijklmnopqrstuv");
  });

  it("loadCursorApiKey returns undefined when file missing", async () => {
    const { loadCursorApiKey } = await import("../src/utils/auth-config.js");
    assert.equal(loadCursorApiKey(), undefined);
  });

  it("loadCursorApiKey returns undefined when file present but apiKey field empty", async () => {
    const { cursorApiKeyPath, loadCursorApiKey } = await import("../src/utils/auth-config.js");
    mkdirSync(join(SANDBOX_HOME, ".config", "axme-code"), { recursive: true });
    writeFileSync(cursorApiKeyPath(), "apiKey: ''\nchosenAt: '2026-01-01'\n");
    assert.equal(loadCursorApiKey(), undefined);
  });
});
