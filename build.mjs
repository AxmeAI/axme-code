import { build } from "esbuild";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const define = { __VERSION__: JSON.stringify(pkg.version) };

// MCP server (main entry)
await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "external",
  outfile: "dist/server.js",
  sourcemap: true,
  define,
});

// CLI entry (setup command)
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "external",
  outfile: "dist/cli.mjs",
  sourcemap: true,
  banner: { js: "" },
  define,
});

// Create bin wrappers — POSIX shebang entry + Windows .cmd wrapper. Shipping
// both means install.sh/install.ps1 can place them side-by-side on any
// platform; the one that matches the shell wins.
import { writeFileSync, chmodSync, mkdirSync } from "fs";
writeFileSync("dist/axme-code.js", '#!/usr/bin/env node\nimport("./cli.mjs");\n');
chmodSync("dist/axme-code.js", 0o755);
// Windows CMD wrapper — forwards all args to node + axme-code.js. %~dp0
// resolves to the directory of the .cmd at runtime so this works regardless
// of cwd or PATH entry style.
writeFileSync("dist/axme-code.cmd", "@echo off\r\nnode \"%~dp0axme-code.js\" %*\r\n");

// --- Plugin bundled builds (self-contained, zero external deps) ---

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "bundle",
  outfile: "dist/plugin/server.mjs",
  sourcemap: true,
  define,
});

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "bundle",
  external: ["@anthropic-ai/claude-agent-sdk"],
  outfile: "dist/plugin/cli.mjs",
  sourcemap: true,
  banner: { js: "" },
  define,
});

// Plugin bin wrappers — POSIX bash script + Windows .cmd. Both forward to
// node + the plugin's bundled cli.mjs, located one directory up from bin/.
mkdirSync("dist/plugin/bin", { recursive: true });
writeFileSync("dist/plugin/bin/axme-code", `#!/bin/bash
PLUGIN_DIR="\$(cd "\$(dirname "\$0")/.." && pwd)"
exec node "\$PLUGIN_DIR/cli.mjs" "\$@"
`);
chmodSync("dist/plugin/bin/axme-code", 0o755);
writeFileSync("dist/plugin/bin/axme-code.cmd", "@echo off\r\nnode \"%~dp0..\\cli.mjs\" %*\r\n");

// Plugin package.json — only SDK for npm install in CLAUDE_PLUGIN_DATA
writeFileSync("dist/plugin/package.json", JSON.stringify({
  name: "@axme/code-plugin",
  private: true,
  dependencies: {
    "@anthropic-ai/claude-agent-sdk": pkg.dependencies["@anthropic-ai/claude-agent-sdk"],
  },
}, null, 2) + "\n");

// --- Assemble plugin directory ---
import { cpSync, existsSync } from "fs";

mkdirSync("dist/plugin/.claude-plugin", { recursive: true });
mkdirSync("dist/plugin/hooks", { recursive: true });

// Plugin manifest
cpSync(".claude-plugin/plugin.json", "dist/plugin/.claude-plugin/plugin.json");

// Plugin .mcp.json — uses ${CLAUDE_PLUGIN_ROOT} for self-contained execution
writeFileSync("dist/plugin/.mcp.json", JSON.stringify({
  mcpServers: {
    axme: {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"],
    },
  },
}, null, 2) + "\n");

// Plugin hooks — safety enforcement via bundled CLI
writeFileSync("dist/plugin/hooks/hooks.json", JSON.stringify({
  description: "AXME Code safety enforcement and session tracking",
  hooks: {
    SessionStart: [{
      hooks: [{
        type: "command",
        command: "test -d ${CLAUDE_PLUGIN_ROOT}/node_modules/@anthropic-ai/claude-agent-sdk || (cd ${CLAUDE_PLUGIN_ROOT} && npm install --omit=dev --ignore-scripts 2>/dev/null) ; node ${CLAUDE_PLUGIN_ROOT}/cli.mjs check-init",
        timeout: 30,
      }],
    }],
    PreToolUse: [{
      hooks: [{
        type: "command",
        command: "node ${CLAUDE_PLUGIN_ROOT}/cli.mjs hook pre-tool-use",
        timeout: 5,
      }],
    }],
    PostToolUse: [{
      matcher: "Edit|Write|NotebookEdit",
      hooks: [{
        type: "command",
        command: "node ${CLAUDE_PLUGIN_ROOT}/cli.mjs hook post-tool-use",
        timeout: 10,
      }],
    }],
    SessionEnd: [{
      hooks: [{
        type: "command",
        command: "node ${CLAUDE_PLUGIN_ROOT}/cli.mjs hook session-end",
        timeout: 120,
      }],
    }],
  },
}, null, 2) + "\n");

// Copy LICENSE and README
if (existsSync("LICENSE")) cpSync("LICENSE", "dist/plugin/LICENSE");
cpSync("templates/plugin-README.md", "dist/plugin/README.md");

console.log("Build complete.");
