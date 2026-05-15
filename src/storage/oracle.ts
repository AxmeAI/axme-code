/**
 * Project Oracle - project knowledge base.
 *
 * Produces: .axme-code/oracle/{stack.md, structure.md, patterns.md, glossary.md}
 * Used by: every agent at session start (relevant sections injected as context)
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, ensureDir, readSafe, pathExists } from "./engine.js";
import type { OracleFiles, OracleData, StackInfo, StructureInfo, DirectoryEntry } from "../types.js";
import { AXME_CODE_DIR } from "../types.js";

const ORACLE_DIR = "oracle";

// --- Public API ---

/**
 * Write oracle markdown files from LLM scan result.
 */
export function writeOracleFiles(projectPath: string, files: OracleFiles): void {
  const dir = oracleDir(projectPath);
  ensureDir(dir);
  atomicWrite(join(dir, "stack.md"), files.stack);
  atomicWrite(join(dir, "structure.md"), files.structure);
  atomicWrite(join(dir, "patterns.md"), files.patterns);
  atomicWrite(join(dir, "glossary.md"), files.glossary);
}

/**
 * Load oracle markdown files. Returns null if not initialized.
 */
export function loadOracleFiles(projectPath: string): OracleFiles | null {
  const dir = oracleDir(projectPath);
  if (!pathExists(dir)) return null;

  const stack = readSafe(join(dir, "stack.md"));
  const structure = readSafe(join(dir, "structure.md"));
  const patterns = readSafe(join(dir, "patterns.md"));
  const glossary = readSafe(join(dir, "glossary.md"));

  if (!stack && !structure && !patterns && !glossary) return null;
  return { stack, structure, patterns, glossary };
}

/**
 * Build context string from oracle files for agent prompts.
 */
export function oracleContext(projectPath: string): string {
  const files = loadOracleFiles(projectPath);
  if (!files) return "";

  const parts: string[] = [];
  if (files.stack) parts.push(`## Stack\n${files.stack}`);
  if (files.structure) parts.push(`## Structure\n${files.structure}`);
  if (files.patterns) parts.push(`## Patterns\n${files.patterns}`);
  if (files.glossary) parts.push(`## Glossary\n${files.glossary}`);
  return parts.join("\n\n");
}

/**
 * Format oracle for display.
 */
export function showOracle(projectPath: string): string {
  return getOracleSections(projectPath).join("\n\n---\n\n");
}

/** Return oracle as array of sections (for pagination). */
export function getOracleSections(projectPath: string): string[] {
  const files = loadOracleFiles(projectPath);
  if (!files) {
    return [
      "Oracle is empty for this project. Two ways to populate:\n\n" +
        "• Cooperative — ask the agent to enrich oracle inline (calls " +
        "axme_save_oracle for each section: stack, structure, patterns, " +
        "glossary).\n" +
        "• API-key path — run `axme-code setup` in a terminal (or " +
        "`AXME: Set up workspace` from Cursor's Command Palette) to run " +
        "the LLM oracle scanner.\n\n" +
        "If `.axme-code/oracle/` already exists but is empty, the MCP " +
        "server bootstraps a deterministic skeleton (detected stack + " +
        "structure) on the next save call — the agent can then enrich it.",
    ];
  }

  const sections: string[] = [];
  if (files.stack) sections.push("# Stack\n\n" + files.stack);
  if (files.structure) sections.push("# Structure\n\n" + files.structure);
  if (files.patterns) sections.push("# Patterns\n\n" + files.patterns);
  if (files.glossary) sections.push("# Glossary\n\n" + files.glossary);
  return sections;
}

/**
 * Bootstrap oracle deterministically if `.axme-code/oracle/` is empty.
 * Called by MCP save tools so cooperative-setup workflows never see the
 * "Oracle is empty" placeholder — the deterministic scan fills stack +
 * structure from package.json / file layout immediately, and the agent
 * can enrich patterns + glossary via axme_save_oracle later.
 *
 * No-op when oracle has any content (we never overwrite). No-op when
 * `.axme-code/` itself doesn't exist (different bootstrap path).
 */
export function ensureOracleBootstrapped(projectPath: string): void {
  if (!pathExists(join(projectPath, AXME_CODE_DIR))) return;
  if (loadOracleFiles(projectPath)) return;
  try { initOracleDeterministic(projectPath); } catch { /* swallow */ }
}

/**
 * Write or update a single oracle section. Used by the axme_save_oracle
 * MCP tool. Mode "replace" overwrites; "append" concatenates with a
 * blank-line separator. Other sections are preserved as-is so the agent
 * can populate one at a time.
 */
export function saveOracleSection(
  projectPath: string,
  section: keyof OracleFiles,
  content: string,
  mode: "replace" | "append" = "replace",
): void {
  const existing = loadOracleFiles(projectPath) ?? { stack: "", structure: "", patterns: "", glossary: "" };
  const next: OracleFiles = { ...existing };
  if (mode === "append" && existing[section]) {
    next[section] = existing[section] + "\n\n" + content;
  } else {
    next[section] = content;
  }
  writeOracleFiles(projectPath, next);
}

export function oracleExists(projectPath: string): boolean {
  return pathExists(join(oracleDir(projectPath), "stack.md"));
}

export function oracleDir(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, ORACLE_DIR);
}

// --- Deterministic scan (fallback when no LLM) ---

export function initOracleDeterministic(projectPath: string): OracleData {
  const data = scanProject(projectPath);
  writeOracleFromData(projectPath, data);
  return data;
}

function writeOracleFromData(projectPath: string, data: OracleData): void {
  writeOracleFiles(projectPath, {
    stack: formatStack(data.stack),
    structure: formatStructure(data.structure),
    patterns: data.patterns || "No patterns detected yet.",
    glossary: data.glossary || "No glossary entries yet.",
  });
}

function scanProject(projectPath: string): OracleData {
  const stack = detectStack(projectPath);
  const structure = detectStructure(projectPath);
  const patterns = detectPatterns(projectPath);
  const glossary = detectGlossary(projectPath);

  // Workspace detection: if root has no languages, scan subdirs
  if (stack.languages.length === 0) {
    const sub = scanSubprojects(projectPath);
    if (sub.languages.size > 0) {
      stack.languages = Array.from(sub.languages);
      stack.frameworks = Array.from(sub.frameworks);
      stack.buildTools = Array.from(sub.buildTools);
      stack.testFrameworks = Array.from(sub.testFrameworks);
      stack.packageManager = sub.packageManager;
    }
    for (const dir of structure.directories) {
      const subType = sub.projectTypes.get(dir.path);
      if (subType) dir.description = subType;
    }
  }

  return { stack, structure, patterns, glossary };
}

interface AggregatedStack {
  languages: Set<string>;
  frameworks: Set<string>;
  buildTools: Set<string>;
  testFrameworks: Set<string>;
  packageManager: string | null;
  projectTypes: Map<string, string>;
}

function scanSubprojects(root: string): AggregatedStack {
  const result: AggregatedStack = {
    languages: new Set(), frameworks: new Set(), buildTools: new Set(),
    testFrameworks: new Set(), packageManager: null, projectTypes: new Map(),
  };

  try {
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(".") || ["node_modules", "dist", "build"].includes(entry)) continue;
      const full = join(root, entry);
      try { if (!statSync(full).isDirectory()) continue; } catch { continue; }

      const sub = detectStack(full);
      if (sub.languages.length === 0) continue;

      for (const l of sub.languages) result.languages.add(l);
      for (const f of sub.frameworks) result.frameworks.add(f);
      for (const b of sub.buildTools) result.buildTools.add(b);
      for (const t of sub.testFrameworks) result.testFrameworks.add(t);
      if (!result.packageManager && sub.packageManager) result.packageManager = sub.packageManager;

      const desc = [sub.languages.join("/"), ...sub.frameworks.slice(0, 2)].join(", ");
      result.projectTypes.set(entry, desc || "project");
    }
  } catch {}

  return result;
}

function detectStack(root: string): StackInfo {
  const info: StackInfo = {
    languages: [], frameworks: [], buildTools: [], testFrameworks: [],
    packageManager: null, nodeVersion: null, pythonVersion: null, goVersion: null,
  };

  // Node.js / TypeScript
  const pkg = readJsonSafe(join(root, "package.json"));
  if (pkg) {
    info.packageManager = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm"
      : existsSync(join(root, "yarn.lock")) ? "yarn"
      : existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")) ? "bun" : "npm";

    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    info.languages.push(deps.typescript || existsSync(join(root, "tsconfig.json")) ? "TypeScript" : "JavaScript");
    info.nodeVersion = pkg.engines?.node ?? null;

    if (deps.next) info.frameworks.push("Next.js");
    if (deps.react) info.frameworks.push("React");
    if (deps.vue) info.frameworks.push("Vue");
    if (deps.express) info.frameworks.push("Express");
    if (deps.fastify) info.frameworks.push("Fastify");
    if (deps.hono) info.frameworks.push("Hono");
    if (deps.vite) info.buildTools.push("Vite");
    if (deps.esbuild) info.buildTools.push("esbuild");
    if (deps.jest) info.testFrameworks.push("Jest");
    if (deps.vitest) info.testFrameworks.push("Vitest");
    if (pkg.scripts?.test?.includes("node --test")) info.testFrameworks.push("node:test");
  }

  // Python
  const pyproject = readSafe(join(root, "pyproject.toml"));
  const requirements = readSafe(join(root, "requirements.txt"));
  if (pyproject || requirements || existsSync(join(root, "setup.py"))) {
    info.languages.push("Python");
    const allPy = (pyproject + "\n" + requirements).toLowerCase();
    if (allPy.includes("pytest")) info.testFrameworks.push("pytest");
    if (allPy.includes("fastapi")) info.frameworks.push("FastAPI");
    if (allPy.includes("django")) info.frameworks.push("Django");
    if (allPy.includes("flask")) info.frameworks.push("Flask");
  }

  // Go
  if (existsSync(join(root, "go.mod"))) {
    info.languages.push("Go");
    const goMod = readSafe(join(root, "go.mod"));
    const ver = goMod.match(/^go\s+(\S+)/m);
    if (ver) info.goVersion = ver[1];
  }

  // Rust
  if (existsSync(join(root, "Cargo.toml"))) {
    info.languages.push("Rust");
    info.buildTools.push("Cargo");
  }

  // Java
  if (existsSync(join(root, "pom.xml"))) {
    info.languages.push("Java");
    info.buildTools.push("Maven");
  } else if (existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts"))) {
    info.languages.push("Java/Kotlin");
    info.buildTools.push("Gradle");
  }

  // .NET
  try {
    if (readdirSync(root).some(f => f.endsWith(".csproj"))) {
      info.languages.push("C#");
      info.buildTools.push("dotnet");
    }
  } catch {}

  return info;
}

function detectStructure(root: string): StructureInfo {
  const rootFiles: string[] = [];
  const directories: DirectoryEntry[] = [];
  const entryPoints: string[] = [];

  try {
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(".") && entry !== ".github") continue;
      if (["node_modules", "dist", "build", "__pycache__"].includes(entry)) continue;
      const full = join(root, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) directories.push({ path: entry, description: guessDirPurpose(entry) });
        else if (stat.isFile()) rootFiles.push(entry);
      } catch {}
    }
  } catch {}

  const pkg = readJsonSafe(join(root, "package.json"));
  if (pkg?.main) entryPoints.push(pkg.main);
  if (pkg?.bin) {
    if (typeof pkg.bin === "string") entryPoints.push(pkg.bin);
    else Object.values(pkg.bin).forEach(v => entryPoints.push(v as string));
  }
  for (const ep of ["src/index.ts", "src/main.ts", "src/index.js"]) {
    if (existsSync(join(root, ep))) entryPoints.push(ep);
  }

  return { rootFiles, directories, entryPoints };
}

function detectPatterns(root: string): string {
  const parts: string[] = [];
  const claude = readSafe(join(root, "CLAUDE.md"));
  if (claude) parts.push("From CLAUDE.md:\n" + claude.slice(0, 3000));
  if (existsSync(join(root, ".editorconfig"))) parts.push("EditorConfig present.");
  for (const f of [".eslintrc.json", "eslint.config.js", "eslint.config.mjs"]) {
    if (existsSync(join(root, f))) { parts.push(`ESLint: ${f}`); break; }
  }
  for (const f of [".prettierrc", ".prettierrc.json", "prettier.config.js"]) {
    if (existsSync(join(root, f))) { parts.push(`Prettier: ${f}`); break; }
  }
  return parts.join("\n\n");
}

function detectGlossary(root: string): string {
  const readme = readSafe(join(root, "README.md"));
  if (!readme) return "";
  const heading = readme.match(/^#\s+(.+)/m);
  return heading ? `- ${heading[1].trim()}: this project` : "";
}

// --- Helpers ---

function formatStack(s: StackInfo): string {
  const lines: string[] = [];
  if (s.languages.length) lines.push(`Languages: ${s.languages.join(", ")}`);
  if (s.frameworks.length) lines.push(`Frameworks: ${s.frameworks.join(", ")}`);
  if (s.buildTools.length) lines.push(`Build: ${s.buildTools.join(", ")}`);
  if (s.testFrameworks.length) lines.push(`Test: ${s.testFrameworks.join(", ")}`);
  if (s.packageManager) lines.push(`Package manager: ${s.packageManager}`);
  if (s.nodeVersion) lines.push(`Node: ${s.nodeVersion}`);
  if (s.pythonVersion) lines.push(`Python: ${s.pythonVersion}`);
  if (s.goVersion) lines.push(`Go: ${s.goVersion}`);
  return lines.join("\n");
}

function formatStructure(s: StructureInfo): string {
  const lines: string[] = [];
  for (const dir of s.directories) lines.push(`${dir.path}/ - ${dir.description}`);
  if (s.entryPoints.length) lines.push(`\nEntry points: ${s.entryPoints.join(", ")}`);
  return lines.join("\n");
}

const DIR_PURPOSE: Record<string, string> = {
  src: "source code", lib: "library code", test: "tests", tests: "tests",
  docs: "documentation", scripts: "build/dev scripts", bin: "executables",
  config: "configuration", public: "static assets", migrations: "database migrations",
  cmd: "Go commands", pkg: "Go packages", internal: "Go internal",
  ".github": "GitHub workflows",
};

function guessDirPurpose(name: string): string {
  return DIR_PURPOSE[name] ?? "project directory";
}

function readJsonSafe(path: string): Record<string, any> | null {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}
