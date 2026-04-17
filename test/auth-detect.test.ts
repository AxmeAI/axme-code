import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { detectAuthOptions } from "../src/utils/auth-detect.js";

const originalKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

describe("detectAuthOptions — API key", () => {
  it("reports not present when ANTHROPIC_API_KEY is unset", () => {
    const options = detectAuthOptions();
    assert.equal(options.apiKey.present, false);
    assert.equal(options.apiKey.masked, undefined);
  });

  it("reports present when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-abcdef1234567890";
    const options = detectAuthOptions();
    assert.equal(options.apiKey.present, true);
    assert.ok(options.apiKey.masked?.startsWith("sk-ant-..."));
    assert.ok(options.apiKey.masked?.endsWith("7890"));
  });

  it("treats empty string and whitespace as not present", () => {
    process.env.ANTHROPIC_API_KEY = "";
    assert.equal(detectAuthOptions().apiKey.present, false);
    process.env.ANTHROPIC_API_KEY = "   ";
    assert.equal(detectAuthOptions().apiKey.present, false);
  });

  it("masks keys without the sk-ant- prefix too", () => {
    process.env.ANTHROPIC_API_KEY = "some-other-format-XYZ12345";
    const { apiKey } = detectAuthOptions();
    assert.equal(apiKey.present, true);
    assert.equal(apiKey.masked, "...2345");
  });
});

describe("detectAuthOptions — subscription", () => {
  it("returns an object regardless of subscription state (no throw)", () => {
    const options = detectAuthOptions();
    assert.ok(typeof options.subscription.present === "boolean");
    assert.ok(typeof options.subscription.binaryFound === "boolean");
  });
});
