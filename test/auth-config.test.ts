import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authConfigPath,
  loadAuthConfig,
  resolveAuthMode,
  saveAuthConfig,
} from "../src/utils/auth-config.js";

const originalHome = process.env.HOME;
const originalKey = process.env.ANTHROPIC_API_KEY;
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "axme-auth-"));
  process.env.HOME = tmpHome;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("auth-config — load/save roundtrip", () => {
  it("returns null when no config exists", () => {
    assert.equal(loadAuthConfig(), null);
  });

  it("saves and loads subscription mode", () => {
    const saved = saveAuthConfig("subscription");
    assert.equal(saved.mode, "subscription");
    assert.ok(saved.chosenAt);

    const loaded = loadAuthConfig();
    assert.equal(loaded?.mode, "subscription");
    assert.equal(loaded?.chosenAt, saved.chosenAt);
  });

  it("saves and loads api_key mode", () => {
    saveAuthConfig("api_key");
    const loaded = loadAuthConfig();
    assert.equal(loaded?.mode, "api_key");
  });

  it("overwrites existing config on save", () => {
    saveAuthConfig("subscription");
    saveAuthConfig("api_key");
    assert.equal(loadAuthConfig()?.mode, "api_key");
  });

  it("returns null for corrupt YAML", () => {
    const configDir = join(tmpHome, ".config", "axme-code");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "auth.yaml"), "not: valid: yaml: [[[");
    assert.equal(loadAuthConfig(), null);
  });

  it("returns null for unknown mode value", () => {
    const configDir = join(tmpHome, ".config", "axme-code");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "auth.yaml"), "mode: gibberish\nchosenAt: 2026-01-01\n");
    assert.equal(loadAuthConfig(), null);
  });

  it("authConfigPath reflects $HOME", () => {
    assert.equal(authConfigPath(), join(tmpHome, ".config", "axme-code", "auth.yaml"));
  });
});

describe("auth-config — resolveAuthMode heuristic", () => {
  it("falls back to a concrete mode when no config exists", () => {
    const mode = resolveAuthMode();
    assert.ok(mode === "subscription" || mode === "api_key");
  });

  it("reads saved config when present regardless of detection", () => {
    saveAuthConfig("subscription");
    assert.equal(resolveAuthMode(), "subscription");
    saveAuthConfig("api_key");
    assert.equal(resolveAuthMode(), "api_key");
  });
});
