#!/usr/bin/env node
/**
 * Cross-platform test runner. Enumerates test/*.test.ts and spawns tsx --test
 * with explicit file paths. Replaces the shell-glob pattern in the npm test
 * script, which fails on Windows because cmd.exe/PowerShell don't expand *.
 */

import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const testDir = resolve("test");
const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join(testDir, f));

if (files.length === 0) {
  console.error(`No .test.ts files found in ${testDir}`);
  process.exit(1);
}

const isWin = process.platform === "win32";
const tsx = isWin ? "npx.cmd" : "npx";
const child = spawn(tsx, ["tsx", "--test", ...files], {
  stdio: "inherit",
  shell: isWin,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  console.error(`Failed to start tsx: ${err.message}`);
  process.exit(1);
});
