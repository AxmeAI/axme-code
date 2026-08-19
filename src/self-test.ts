/**
 * `axme-code self-test` — a CI/CLI healthcheck that probes the four
 * runtime contracts users will hit when the extension is alive:
 *
 *   1. Storage write — can we atomic-write a file to a temp .axme-code/?
 *   2. Hook stdin parse — does the Cursor adapter normalize Shell→Bash
 *      and the Claude adapter pass-through Bash, both producing the
 *      expected NormalizedHookEvent?
 *   3. Hook deny emit — do both IDE output adapters produce the right
 *      JSON shape + exit-code contract?
 *   4. MCP server boot — does `axme-code serve` answer an initialize
 *      handshake on stdio within 5s?
 *
 * Output is plain text (one line per check), exit 0 on all-pass / exit 1
 * on any failure. Designed for `axme-code self-test && echo OK` in CI
 * scripts and for users running the binary directly when something
 * looks wrong.
 *
 * No LLM, no auth, no network — everything tested here is local
 * infrastructure that should work on a fresh install with zero state.
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const icon = ok ? "✓" : "✗";
  process.stdout.write(`  ${icon} ${name.padEnd(28)} ${detail}\n`);
}

async function checkStorageWrite(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "axme-selftest-"));
  try {
    const { atomicWrite } = await import("./storage/engine.js");
    const target = join(tmpDir, ".axme-code", "memory", "patterns", "selftest.md");
    atomicWrite(target, "selftest content\n");
    if (!existsSync(target)) {
      record("storage write", false, "atomicWrite returned but file missing");
      return;
    }
    const back = readFileSync(target, "utf-8");
    if (back !== "selftest content\n") {
      record("storage write", false, `content mismatch: ${JSON.stringify(back.slice(0, 40))}`);
      return;
    }
    record("storage write", true, `${target}`);
  } catch (err) {
    record("storage write", false, (err as Error).message);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Round-trip a non-Latin title through the save path.
 *
 * Regression guard for the defect that made this whole check worth having:
 * a Cyrillic-only title used to reduce to an empty slug, land as bare
 * `.md`, and be overwritten by the next such title. The check asserts both
 * halves — that the file has a real name, and that two different non-Latin
 * titles do not collapse onto one.
 */
async function checkNonLatinSlug(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "axme-selftest-slug-"));
  try {
    const { saveMemory, toMemorySlug, listMemories } = await import("./storage/memory.js");
    const titles = ["Перекат даты в bf_live", "Ловушка watchdog при рестарте"];
    for (const title of titles) {
      saveMemory(tmpDir, {
        slug: toMemorySlug(title), type: "pattern", title,
        description: "selftest", body: "", keywords: [],
        source: "manual", sessionId: null, date: "2026-01-01",
      });
    }

    const dir = join(tmpDir, ".axme-code", "memory", "patterns");
    const files = readdirSync(dir);
    const empty = files.filter(f => f === ".md");
    if (empty.length > 0) {
      record("non-latin slug", false, "memory written as bare '.md' — dotfile, and the next such title overwrites it");
      return;
    }
    const stored = listMemories(tmpDir);
    if (stored.length !== titles.length) {
      record("non-latin slug", false, `${titles.length} distinct titles saved but ${stored.length} readable back — entries are colliding`);
      return;
    }
    record("non-latin slug", true, files.sort().join(", "));
  } catch (err) {
    record("non-latin slug", false, (err as Error).message);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function checkHookParseAndDeny(): Promise<void> {
  try {
    const { cursorInputAdapter, cursorOutputAdapter } = await import("./hooks/adapters/cursor.js");
    const { claudeCodeInputAdapter, claudeCodeOutputAdapter } = await import("./hooks/adapters/claude-code.js");

    // Cursor: Shell must normalize to Bash; deny JSON + exit 2
    const cursorEvent = cursorInputAdapter.parse(
      {
        cursor_version: "1.7",
        conversation_id: "selftest",
        workspace_roots: ["/tmp"],
        tool_name: "Shell",
        tool_input: { command: "git push --force origin main" },
      },
      "preToolUse",
    );
    if (cursorEvent.toolName !== "Bash") {
      record("hook parse (Cursor)", false, `expected toolName=Bash, got=${cursorEvent.toolName}`);
      return;
    }
    if (cursorEvent.ide !== "cursor") {
      record("hook parse (Cursor)", false, `expected ide=cursor, got=${cursorEvent.ide}`);
      return;
    }
    record("hook parse (Cursor)", true, "Shell→Bash + ide=cursor");

    const cursorDeny = cursorOutputAdapter.emitDeny("test deny", "preToolUse");
    const cursorJson = JSON.parse(cursorDeny.stdout);
    if (cursorDeny.exitCode !== 2 || cursorJson.permission !== "deny" || !cursorJson.user_message.includes("[AXME Safety]")) {
      record("hook deny (Cursor)", false, `exit=${cursorDeny.exitCode}, json=${cursorDeny.stdout.slice(0, 100)}`);
      return;
    }
    record("hook deny (Cursor)", true, `exit 2 + permission:deny + [AXME Safety]`);

    // Claude: Bash stays Bash; deny JSON via hookSpecificOutput + exit 0
    const claudeEvent = claudeCodeInputAdapter.parse(
      { tool_name: "Bash", tool_input: { command: "git push --force origin main" }, session_id: "claude-x" },
      "preToolUse",
    );
    if (claudeEvent.toolName !== "Bash" || claudeEvent.ide !== "claude-code") {
      record("hook parse (Claude)", false, `tool=${claudeEvent.toolName} ide=${claudeEvent.ide}`);
      return;
    }
    record("hook parse (Claude)", true, "Bash + ide=claude-code");

    const claudeDeny = claudeCodeOutputAdapter.emitDeny("test deny", "preToolUse");
    const claudeJson = JSON.parse(claudeDeny.stdout);
    if (
      claudeDeny.exitCode !== 0 ||
      claudeJson.hookSpecificOutput?.permissionDecision !== "deny" ||
      !String(claudeJson.hookSpecificOutput?.permissionDecisionReason ?? "").includes("[AXME Safety]")
    ) {
      record("hook deny (Claude)", false, `exit=${claudeDeny.exitCode}, json=${claudeDeny.stdout.slice(0, 100)}`);
      return;
    }
    record("hook deny (Claude)", true, "exit 0 + hookSpecificOutput.permissionDecision:deny");
  } catch (err) {
    record("hook parse/deny", false, (err as Error).message);
  }
}

async function checkMcpServerBoot(binaryPath: string): Promise<void> {
  // Spawn `axme-code serve`, send initialize, expect `protocolVersion` in
  // reply within 5s. Then kill the subprocess.
  //
  // Cross-platform spawn: the bundled binary is a shebang-shim text file
  // (CJS code with `#!/usr/bin/env node` prefix). POSIX systems execute
  // it directly via the shebang; Windows treats it as an unrecognized
  // executable and spawn() throws ENOENT / UNKNOWN. On Windows we call
  // through `node <binary>` so the JS payload runs regardless of the
  // file extension (.exe / .cjs / no-ext — all are text).
  const isWindows = process.platform === "win32";
  return new Promise<void>((resolve) => {
    const child = isWindows
      ? spawn(process.execPath, [binaryPath, "serve"], { stdio: ["pipe", "pipe", "pipe"] })
      : spawn(binaryPath, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let resolved = false;
    const finish = (ok: boolean, detail: string) => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch { /* swallow */ }
      record("MCP server boot", ok, detail);
      resolve();
    };
    const timer = setTimeout(() => finish(false, "no response after 5s"), 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes("\"protocolVersion\"")) {
        clearTimeout(timer);
        finish(true, "stdio handshake ok");
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(false, err.message);
    });
    child.on("exit", (code) => {
      if (resolved) return;
      clearTimeout(timer);
      finish(false, `exited prematurely (code ${code})`);
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "selftest", version: "0.0.2" } },
      }) + "\n",
    );
  });
}

/**
 * Entry point invoked from cli.ts when the user runs `axme-code self-test`.
 * Picks the binary path off process.argv[1] for the MCP boot check.
 */
export async function runSelfTest(): Promise<number> {
  process.stdout.write("axme-code self-test\n");
  process.stdout.write("====================\n\n");

  await checkStorageWrite();
  await checkNonLatinSlug();
  await checkHookParseAndDeny();

  // For the MCP boot, we need a path to our own binary. process.argv[1]
  // is the CLI entry that's currently running this code. Spawning it
  // recursively as a child is safe — child does `axme-code serve` not
  // `axme-code self-test`, so no infinite recursion.
  const selfPath = process.argv[1];
  if (selfPath && existsSync(selfPath)) {
    await checkMcpServerBoot(selfPath);
  } else {
    record("MCP server boot", false, "cannot locate own binary at process.argv[1]");
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write("\n");
  if (failed.length === 0) {
    process.stdout.write(`All ${results.length} checks passed.\n`);
    return 0;
  }
  process.stdout.write(`${failed.length} of ${results.length} checks FAILED:\n`);
  for (const f of failed) {
    process.stdout.write(`  - ${f.name}: ${f.detail}\n`);
  }
  return 1;
}
