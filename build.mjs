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
import { writeFileSync, chmodSync } from "fs";
writeFileSync("dist/axme-code.js", '#!/usr/bin/env node\nimport("./cli.mjs");\n');
chmodSync("dist/axme-code.js", 0o755);

console.log("Build complete.");
