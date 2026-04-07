import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWrite,
  appendLine,
  readSafe,
  readJson,
  writeJson,
  ensureDir,
  pathExists,
  listFiles,
  isDir,
  removeFile,
} from "../src/storage/engine.js";

const root = "/tmp/axme-engine-test";

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// atomicWrite
// ---------------------------------------------------------------------------

describe("atomicWrite", () => {
  it("writes file correctly", () => {
    const p = join(root, "file.txt");
    atomicWrite(p, "hello world");
    assert.equal(readSafe(p), "hello world");
  });

  it("creates parent directories", () => {
    const p = join(root, "deep", "nested", "dir", "file.txt");
    atomicWrite(p, "nested content");
    assert.equal(readSafe(p), "nested content");
  });

  it("overwrites existing file", () => {
    const p = join(root, "overwrite.txt");
    atomicWrite(p, "first");
    atomicWrite(p, "second");
    assert.equal(readSafe(p), "second");
  });

  it("content matches on read back", () => {
    const p = join(root, "readback.txt");
    const content = "line1\nline2\nline3\n";
    atomicWrite(p, content);
    assert.equal(readSafe(p), content);
  });
});

// ---------------------------------------------------------------------------
// appendLine
// ---------------------------------------------------------------------------

describe("appendLine", () => {
  it("appends single line with newline terminator", () => {
    const p = join(root, "append.txt");
    appendLine(p, "first line");
    assert.equal(readSafe(p), "first line\n");
  });

  it("appends multiple lines, each newline terminated", () => {
    const p = join(root, "multi.txt");
    appendLine(p, "line1");
    appendLine(p, "line2");
    appendLine(p, "line3");
    assert.equal(readSafe(p), "line1\nline2\nline3\n");
  });

  it("creates file and parent dirs if missing", () => {
    const p = join(root, "new", "sub", "append.log");
    appendLine(p, "created");
    assert.equal(readSafe(p), "created\n");
  });
});

// ---------------------------------------------------------------------------
// readSafe
// ---------------------------------------------------------------------------

describe("readSafe", () => {
  it("reads existing file", () => {
    const p = join(root, "existing.txt");
    atomicWrite(p, "content here");
    assert.equal(readSafe(p), "content here");
  });

  it("returns empty string for missing file", () => {
    assert.equal(readSafe(join(root, "nonexistent.txt")), "");
  });
});

// ---------------------------------------------------------------------------
// readJson / writeJson
// ---------------------------------------------------------------------------

describe("readJson / writeJson", () => {
  it("round-trips JSON data", () => {
    const p = join(root, "data.json");
    const data = { name: "test", count: 42, nested: { flag: true } };
    writeJson(p, data);
    const result = readJson<typeof data>(p);
    assert.deepEqual(result, data);
  });

  it("returns null for missing file", () => {
    assert.equal(readJson(join(root, "missing.json")), null);
  });

  it("returns null for invalid JSON", () => {
    const p = join(root, "invalid.json");
    atomicWrite(p, "not valid json {{{");
    assert.equal(readJson(p), null);
  });
});

// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------

describe("ensureDir", () => {
  it("creates directory", () => {
    const d = join(root, "newdir");
    ensureDir(d);
    assert.equal(isDir(d), true);
  });

  it("is idempotent", () => {
    const d = join(root, "idempotent");
    ensureDir(d);
    ensureDir(d);
    assert.equal(isDir(d), true);
  });
});

// ---------------------------------------------------------------------------
// pathExists
// ---------------------------------------------------------------------------

describe("pathExists", () => {
  it("returns true for existing file", () => {
    const p = join(root, "exists.txt");
    atomicWrite(p, "x");
    assert.equal(pathExists(p), true);
  });

  it("returns true for existing directory", () => {
    const d = join(root, "existsdir");
    ensureDir(d);
    assert.equal(pathExists(d), true);
  });

  it("returns false for missing path", () => {
    assert.equal(pathExists(join(root, "nope")), false);
  });
});

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------

describe("listFiles", () => {
  it("lists files in directory", () => {
    const d = join(root, "listdir");
    atomicWrite(join(d, "a.txt"), "a");
    atomicWrite(join(d, "b.txt"), "b");
    atomicWrite(join(d, "c.log"), "c");
    const files = listFiles(d).sort();
    assert.deepEqual(files, ["a.txt", "b.txt", "c.log"]);
  });

  it("returns empty array for missing directory", () => {
    assert.deepEqual(listFiles(join(root, "nodir")), []);
  });

  it("filter works", () => {
    const d = join(root, "filterdir");
    atomicWrite(join(d, "a.txt"), "a");
    atomicWrite(join(d, "b.txt"), "b");
    atomicWrite(join(d, "c.log"), "c");
    const files = listFiles(d, (name) => name.endsWith(".txt")).sort();
    assert.deepEqual(files, ["a.txt", "b.txt"]);
  });
});

// ---------------------------------------------------------------------------
// isDir
// ---------------------------------------------------------------------------

describe("isDir", () => {
  it("returns true for directory", () => {
    const d = join(root, "adir");
    ensureDir(d);
    assert.equal(isDir(d), true);
  });

  it("returns false for file", () => {
    const p = join(root, "afile.txt");
    atomicWrite(p, "content");
    assert.equal(isDir(p), false);
  });

  it("returns false for missing path", () => {
    assert.equal(isDir(join(root, "missing")), false);
  });
});

// ---------------------------------------------------------------------------
// removeFile
// ---------------------------------------------------------------------------

describe("removeFile", () => {
  it("removes existing file and returns true", () => {
    const p = join(root, "removeme.txt");
    atomicWrite(p, "bye");
    assert.equal(removeFile(p), true);
    assert.equal(pathExists(p), false);
  });

  it("returns false for missing file", () => {
    assert.equal(removeFile(join(root, "ghost.txt")), false);
  });
});
