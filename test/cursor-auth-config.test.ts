import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Override $HOME so the auth-config module reads from a sandboxed path.
const SANDBOX_HOME = "/tmp/axme-cursor-auth-test-home";
const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  mkdirSync(SANDBOX_HOME, { recursive: true });
  process.env.HOME = SANDBOX_HOME;
});

afterEach(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
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
