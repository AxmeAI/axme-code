import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCodexHooksJson,
  writeCodexConfigToml,
  writeAgentsMdSection,
  buildAgentsMdSection,
} from "../src/setup/codex-writers.js";

let ROOT = "";

function fakeBuildHookCommand(hookName: string, projectPath: string): string {
  return `"/bin/node" "/usr/local/bin/axme-code" hook ${hookName} --workspace "${projectPath}"`;
}

const SERVE = { command: "/bin/node", args: ["/usr/local/bin/axme-code", "serve"] };

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "axme-codex-writers-"));
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("writeCodexHooksJson", () => {
  it("creates .codex/hooks.json with four PascalCase events, --ide codex, Codex-safe timeouts", () => {
    writeCodexHooksJson(ROOT, fakeBuildHookCommand);
    const path = join(ROOT, ".codex", "hooks.json");
    assert.ok(existsSync(path));
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "SessionEnd"]) {
      const groups = cfg.hooks[event];
      assert.ok(Array.isArray(groups) && groups.length === 1, `${event} should have one group`);
      const cmd = groups[0].hooks[0];
      assert.equal(cmd.type, "command");
      assert.match(cmd.command, /--ide codex$/);
      assert.match(cmd.command, /axme-code/);
      assert.ok(typeof cmd.timeout === "number");
    }
    // Codex hard-caps SessionEnd at 3s.
    assert.ok(cfg.hooks.SessionEnd[0].hooks[0].timeout <= 3);
    // PreToolUse must fire for every tool (no matcher) — D-101.
    assert.equal(cfg.hooks.PreToolUse[0].matcher, undefined);
    // PostToolUse is edit-only and names Codex's real tool.
    assert.match(cfg.hooks.PostToolUse[0].matcher, /apply_patch/);
    assert.match(cfg.hooks.SessionStart[0].hooks[0].command, /hook session-start/);
  });

  it("dedups axme groups on re-run, preserves user groups", () => {
    mkdirSync(join(ROOT, ".codex"), { recursive: true });
    writeFileSync(
      join(ROOT, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] },
            { hooks: [{ type: "command", command: "axme-code hook pre-tool-use --workspace OLD --ide codex" }] },
          ],
        },
      }),
    );
    writeCodexHooksJson(ROOT, fakeBuildHookCommand);
    writeCodexHooksJson(ROOT, fakeBuildHookCommand);
    const cfg = JSON.parse(readFileSync(join(ROOT, ".codex", "hooks.json"), "utf-8"));
    const pre = cfg.hooks.PreToolUse;
    assert.equal(pre.length, 2);
    assert.equal(pre[0].hooks[0].command, "echo user-hook");
    assert.match(pre[1].hooks[0].command, new RegExp(`--workspace "${ROOT}" --ide codex`));
    assert.equal(cfg.hooks.SessionEnd.length, 1);
  });

  it("refuses to overwrite an unparseable hooks.json", () => {
    mkdirSync(join(ROOT, ".codex"), { recursive: true });
    const path = join(ROOT, ".codex", "hooks.json");
    writeFileSync(path, "{ not json");
    const origError = console.error;
    const msgs: string[] = [];
    console.error = (m: string) => { msgs.push(String(m)); };
    try { writeCodexHooksJson(ROOT, fakeBuildHookCommand); } finally { console.error = origError; }
    assert.equal(readFileSync(path, "utf-8"), "{ not json");
    assert.ok(msgs.some((m) => m.includes("SKIPPED")));
  });
});

describe("writeCodexConfigToml", () => {
  it("creates .codex/config.toml with the axme table (absolute command + args)", () => {
    writeCodexConfigToml(ROOT, SERVE);
    const text = readFileSync(join(ROOT, ".codex", "config.toml"), "utf-8");
    assert.equal(text, '[mcp_servers.axme]\ncommand = "/bin/node"\nargs = ["/usr/local/bin/axme-code", "serve"]\n');
  });

  it("appends to an existing config without touching other tables or comments", () => {
    mkdirSync(join(ROOT, ".codex"), { recursive: true });
    const before = '# my project config\nmodel = "gpt-5-codex"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n';
    writeFileSync(join(ROOT, ".codex", "config.toml"), before);
    writeCodexConfigToml(ROOT, SERVE);
    const text = readFileSync(join(ROOT, ".codex", "config.toml"), "utf-8");
    assert.ok(text.startsWith(before), "existing content must be preserved verbatim at the top");
    assert.match(text, /\n\[mcp_servers\.axme\]\ncommand = "\/bin\/node"\n/);
  });

  it("replaces a stale axme table in place and keeps what follows", () => {
    mkdirSync(join(ROOT, ".codex"), { recursive: true });
    writeFileSync(
      join(ROOT, ".codex", "config.toml"),
      '[mcp_servers.axme]\ncommand = "axme-code"\nargs = ["serve"]\n\n[mcp_servers.other]\ncommand = "other-mcp"\n# trailing comment\n',
    );
    writeCodexConfigToml(ROOT, SERVE);
    const text = readFileSync(join(ROOT, ".codex", "config.toml"), "utf-8");
    assert.equal(text.match(/\[mcp_servers\.axme\]/g)?.length, 1);
    assert.doesNotMatch(text, /command = "axme-code"/);
    assert.match(text, /command = "\/bin\/node"/);
    assert.match(text, /\[mcp_servers\.other\]\ncommand = "other-mcp"\n# trailing comment\n$/);
  });

  it("is idempotent", () => {
    writeCodexConfigToml(ROOT, SERVE);
    const once = readFileSync(join(ROOT, ".codex", "config.toml"), "utf-8");
    writeCodexConfigToml(ROOT, SERVE);
    assert.equal(readFileSync(join(ROOT, ".codex", "config.toml"), "utf-8"), once);
  });

  it("escapes Windows-style paths as valid TOML basic strings", () => {
    writeCodexConfigToml(ROOT, { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\axme\\cli.mjs", "serve"] });
    const text = readFileSync(join(ROOT, ".codex", "config.toml"), "utf-8");
    assert.match(text, /command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/);
  });
});

describe("writeAgentsMdSection", () => {
  const SECTION = buildAgentsMdSection("## AXME Code\n\n### Session Start (MANDATORY)\nCall axme_context first.\n");

  it("appends the git gate to the base section", () => {
    assert.match(SECTION, /^## AXME Code\n/);
    assert.match(SECTION, /#!axme pr=<NUMBER\|none> repo=<OWNER\/REPO>/);
  });

  it("creates AGENTS.md when missing", () => {
    assert.equal(writeAgentsMdSection(ROOT, SECTION), "created");
    assert.equal(readFileSync(join(ROOT, "AGENTS.md"), "utf-8"), SECTION);
  });

  it("appends to an existing AGENTS.md without our section", () => {
    writeFileSync(join(ROOT, "AGENTS.md"), "# Project rules\n\nUse pnpm.\n");
    assert.equal(writeAgentsMdSection(ROOT, SECTION), "appended");
    const text = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");
    assert.ok(text.startsWith("# Project rules\n\nUse pnpm.\n\n## AXME Code"));
  });

  it("refreshes only our section and keeps user content after it", () => {
    writeFileSync(
      join(ROOT, "AGENTS.md"),
      "# Project rules\n\n## AXME Code\n\nold stale text\n\n### Old sub\nstale\n\n## Testing\n\nRun npm test.\n",
    );
    assert.equal(writeAgentsMdSection(ROOT, SECTION), "updated");
    const text = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");
    assert.doesNotMatch(text, /old stale text|### Old sub/);
    assert.equal(text.match(/## AXME Code/g)?.length, 1);
    assert.match(text, /^# Project rules\n\n## AXME Code\n/);
    assert.match(text, /\n## Testing\n\nRun npm test\.\n$/);
  });

  it("is idempotent", () => {
    writeAgentsMdSection(ROOT, SECTION);
    const once = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");
    assert.equal(writeAgentsMdSection(ROOT, SECTION), "updated");
    assert.equal(readFileSync(join(ROOT, "AGENTS.md"), "utf-8"), once);
  });
});
