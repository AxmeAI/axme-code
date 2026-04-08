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

// Create bin wrapper
import { writeFileSync, chmodSync, mkdirSync } from "fs";
writeFileSync("dist/axme-code.js", '#!/usr/bin/env node\nimport("./cli.mjs");\n');
chmodSync("dist/axme-code.js", 0o755);

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
  outfile: "dist/plugin/cli.mjs",
  sourcemap: true,
  banner: { js: "" },
  define,
});

// Plugin bin wrapper
mkdirSync("dist/plugin/bin", { recursive: true });
writeFileSync("dist/plugin/bin/axme-code", '#!/usr/bin/env node\nimport("../cli.mjs");\n');
chmodSync("dist/plugin/bin/axme-code", 0o755);

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

console.log("Build complete.");
