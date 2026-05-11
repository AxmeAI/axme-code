/**
 * Bundle the AXME Code VS Code extension entry point.
 *
 * VS Code extensions are loaded as CommonJS, with `vscode` provided by the
 * host (must stay external). Everything else is inlined into a single file
 * so the .vsix has no node_modules at runtime — that keeps the artifact
 * small (well under 1 MB) and avoids platform-specific binary surprises.
 */

import { build, context } from "esbuild";
import { readFileSync } from "fs";

const watch = process.argv.includes("--watch");

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  outfile: "out/extension.js",
  sourcemap: true,
  define: {
    __EXTENSION_VERSION__: JSON.stringify(pkg.version),
  },
};

if (watch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log("Watching extension/...");
} else {
  await build(buildOptions);
  console.log(`Built extension v${pkg.version} → out/extension.js`);
}
