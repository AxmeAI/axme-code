import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  writeOracleFiles,
  loadOracleFiles,
  oracleContext,
  showOracle,
  getOracleSections,
  oracleExists,
  oracleDir,
  initOracleDeterministic,
} from "../src/storage/oracle.js";

const ROOT = "/tmp/axme-oracle-test";
const PROJECT = join(ROOT, "project");
const AXME_DIR = join(PROJECT, ".axme-code");

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeOracleFiles / loadOracleFiles
// ---------------------------------------------------------------------------

describe("writeOracleFiles + loadOracleFiles", () => {
  it("round-trip: write and load oracle files", () => {
    const files = {
      stack: "Languages: TypeScript",
      structure: "src/ - source code",
      patterns: "ESLint present",
      glossary: "- AXME: project",
    };
    writeOracleFiles(PROJECT, files);
    const loaded = loadOracleFiles(PROJECT);
    assert.ok(loaded);
    assert.equal(loaded.stack, files.stack);
    assert.equal(loaded.structure, files.structure);
    assert.equal(loaded.patterns, files.patterns);
    assert.equal(loaded.glossary, files.glossary);
  });

  it("returns null when oracle not initialized", () => {
    const loaded = loadOracleFiles(PROJECT);
    assert.equal(loaded, null);
  });

  it("returns null when all files are empty", () => {
    mkdirSync(join(AXME_DIR, "oracle"), { recursive: true });
    writeFileSync(join(AXME_DIR, "oracle", "stack.md"), "");
    writeFileSync(join(AXME_DIR, "oracle", "structure.md"), "");
    writeFileSync(join(AXME_DIR, "oracle", "patterns.md"), "");
    writeFileSync(join(AXME_DIR, "oracle", "glossary.md"), "");
    const loaded = loadOracleFiles(PROJECT);
    assert.equal(loaded, null);
  });

  it("overwrites existing files", () => {
    writeOracleFiles(PROJECT, { stack: "old", structure: "old", patterns: "old", glossary: "old" });
    writeOracleFiles(PROJECT, { stack: "new", structure: "new", patterns: "new", glossary: "new" });
    const loaded = loadOracleFiles(PROJECT);
    assert.ok(loaded);
    assert.equal(loaded.stack, "new");
  });
});

// ---------------------------------------------------------------------------
// oracleContext
// ---------------------------------------------------------------------------

describe("oracleContext", () => {
  it("returns empty string when not initialized", () => {
    assert.equal(oracleContext(PROJECT), "");
  });

  it("formats sections with headers", () => {
    writeOracleFiles(PROJECT, { stack: "TS", structure: "src/", patterns: "ESLint", glossary: "term" });
    const ctx = oracleContext(PROJECT);
    assert.ok(ctx.includes("## Stack\nTS"));
    assert.ok(ctx.includes("## Structure\nsrc/"));
    assert.ok(ctx.includes("## Patterns\nESLint"));
    assert.ok(ctx.includes("## Glossary\nterm"));
  });

  it("omits empty sections", () => {
    writeOracleFiles(PROJECT, { stack: "TS", structure: "", patterns: "", glossary: "" });
    const ctx = oracleContext(PROJECT);
    assert.ok(ctx.includes("## Stack"));
    assert.ok(!ctx.includes("## Structure"));
    assert.ok(!ctx.includes("## Patterns"));
    assert.ok(!ctx.includes("## Glossary"));
  });
});

// ---------------------------------------------------------------------------
// showOracle / getOracleSections
// ---------------------------------------------------------------------------

describe("showOracle + getOracleSections", () => {
  it("returns init message when not initialized", () => {
    // Old version produced "Oracle not initialized. Run axme_init first."
    // — but axme_init was removed and the message is now a longer
    // explainer with both paths (cooperative + API-key). Assert on the
    // signal phrase "Oracle is empty" instead.
    const sections = getOracleSections(PROJECT);
    assert.equal(sections.length, 1);
    assert.ok(sections[0].includes("Oracle is empty"));
  });

  it("returns sections array for pagination", () => {
    writeOracleFiles(PROJECT, { stack: "TS", structure: "src/", patterns: "ESLint", glossary: "term" });
    const sections = getOracleSections(PROJECT);
    assert.equal(sections.length, 4);
    assert.ok(sections[0].startsWith("# Stack"));
    assert.ok(sections[1].startsWith("# Structure"));
  });

  it("showOracle joins sections with dividers", () => {
    writeOracleFiles(PROJECT, { stack: "TS", structure: "src/", patterns: "", glossary: "" });
    const output = showOracle(PROJECT);
    assert.ok(output.includes("# Stack"));
    assert.ok(output.includes("# Structure"));
    assert.ok(output.includes("---"));
  });
});

// ---------------------------------------------------------------------------
// oracleExists / oracleDir
// ---------------------------------------------------------------------------

describe("oracleExists + oracleDir", () => {
  it("returns false before init", () => {
    assert.equal(oracleExists(PROJECT), false);
  });

  it("returns true after write", () => {
    writeOracleFiles(PROJECT, { stack: "TS", structure: "", patterns: "", glossary: "" });
    assert.equal(oracleExists(PROJECT), true);
  });

  it("oracleDir returns correct path", () => {
    assert.equal(oracleDir(PROJECT), join(PROJECT, ".axme-code", "oracle"));
  });
});

// ---------------------------------------------------------------------------
// initOracleDeterministic - detectStack
// ---------------------------------------------------------------------------

describe("initOracleDeterministic - Node.js/TypeScript detection", () => {
  it("detects TypeScript + npm from package.json + tsconfig", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({
      dependencies: { typescript: "^5.0.0" },
      devDependencies: { esbuild: "^0.25.0", jest: "^29.0.0" },
    }));
    writeFileSync(join(PROJECT, "tsconfig.json"), "{}");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("TypeScript"));
    assert.equal(data.stack.packageManager, "npm");
    assert.ok(data.stack.buildTools.includes("esbuild"));
    assert.ok(data.stack.testFrameworks.includes("Jest"));
  });

  it("detects JavaScript when no typescript dependency or tsconfig", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({
      dependencies: { express: "^4.0.0" },
    }));

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("JavaScript"));
    assert.ok(data.stack.frameworks.includes("Express"));
  });

  it("detects pnpm from pnpm-lock.yaml", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({}));
    writeFileSync(join(PROJECT, "pnpm-lock.yaml"), "lockfileVersion: 9");

    const data = initOracleDeterministic(PROJECT);
    assert.equal(data.stack.packageManager, "pnpm");
  });

  it("detects yarn from yarn.lock", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({}));
    writeFileSync(join(PROJECT, "yarn.lock"), "# yarn lockfile v1");

    const data = initOracleDeterministic(PROJECT);
    assert.equal(data.stack.packageManager, "yarn");
  });

  it("detects bun from bun.lock", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({}));
    writeFileSync(join(PROJECT, "bun.lock"), "{}");

    const data = initOracleDeterministic(PROJECT);
    assert.equal(data.stack.packageManager, "bun");
  });

  it("detects frameworks: Next.js, React, Vue, Fastify, Hono", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({
      dependencies: { next: "^14", react: "^18", vue: "^3", fastify: "^4", hono: "^4" },
    }));

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.frameworks.includes("Next.js"));
    assert.ok(data.stack.frameworks.includes("React"));
    assert.ok(data.stack.frameworks.includes("Vue"));
    assert.ok(data.stack.frameworks.includes("Fastify"));
    assert.ok(data.stack.frameworks.includes("Hono"));
  });

  it("detects Vite build tool", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({
      devDependencies: { vite: "^5.0.0" },
    }));

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.buildTools.includes("Vite"));
  });

  it("detects vitest and node:test frameworks", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({
      devDependencies: { vitest: "^1.0.0" },
      scripts: { test: "node --test test/*.test.ts" },
    }));

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.testFrameworks.includes("Vitest"));
    assert.ok(data.stack.testFrameworks.includes("node:test"));
  });

  it("reads node engine version", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({
      engines: { node: ">=20" },
    }));

    const data = initOracleDeterministic(PROJECT);
    assert.equal(data.stack.nodeVersion, ">=20");
  });
});

describe("initOracleDeterministic - Python detection", () => {
  it("detects Python from requirements.txt", () => {
    writeFileSync(join(PROJECT, "requirements.txt"), "fastapi==0.133.0\npytest==9.0.0\n");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("Python"));
    assert.ok(data.stack.frameworks.includes("FastAPI"));
    assert.ok(data.stack.testFrameworks.includes("pytest"));
  });

  it("detects Python from pyproject.toml", () => {
    writeFileSync(join(PROJECT, "pyproject.toml"), '[tool.pytest]\n[project]\ndependencies = ["django"]');

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("Python"));
    assert.ok(data.stack.testFrameworks.includes("pytest"));
    assert.ok(data.stack.frameworks.includes("Django"));
  });

  it("detects Python from setup.py", () => {
    writeFileSync(join(PROJECT, "setup.py"), "from setuptools import setup");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("Python"));
  });

  it("detects Flask framework", () => {
    writeFileSync(join(PROJECT, "requirements.txt"), "flask==3.0.0\n");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.frameworks.includes("Flask"));
  });
});

describe("initOracleDeterministic - Go detection", () => {
  it("detects Go from go.mod with version", () => {
    writeFileSync(join(PROJECT, "go.mod"), "module example.com/myapp\n\ngo 1.24\n");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("Go"));
    assert.equal(data.stack.goVersion, "1.24");
  });
});

describe("initOracleDeterministic - Rust detection", () => {
  it("detects Rust from Cargo.toml", () => {
    writeFileSync(join(PROJECT, "Cargo.toml"), '[package]\nname = "myapp"');

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("Rust"));
    assert.ok(data.stack.buildTools.includes("Cargo"));
  });
});

describe("initOracleDeterministic - Java detection", () => {
  it("detects Java + Maven from pom.xml", () => {
    writeFileSync(join(PROJECT, "pom.xml"), "<project></project>");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("Java"));
    assert.ok(data.stack.buildTools.includes("Maven"));
  });

  it("detects Java/Kotlin + Gradle from build.gradle", () => {
    writeFileSync(join(PROJECT, "build.gradle"), "plugins {}");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("Java/Kotlin"));
    assert.ok(data.stack.buildTools.includes("Gradle"));
  });

  it("detects Gradle from build.gradle.kts", () => {
    writeFileSync(join(PROJECT, "build.gradle.kts"), "plugins {}");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("Java/Kotlin"));
    assert.ok(data.stack.buildTools.includes("Gradle"));
  });
});

describe("initOracleDeterministic - .NET detection", () => {
  it("detects C# from .csproj file", () => {
    writeFileSync(join(PROJECT, "MyApp.csproj"), "<Project></Project>");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("C#"));
    assert.ok(data.stack.buildTools.includes("dotnet"));
  });
});

describe("initOracleDeterministic - multi-language project", () => {
  it("detects multiple languages in one project", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({ dependencies: { typescript: "^5" } }));
    writeFileSync(join(PROJECT, "tsconfig.json"), "{}");
    writeFileSync(join(PROJECT, "requirements.txt"), "fastapi\n");
    writeFileSync(join(PROJECT, "go.mod"), "module test\n\ngo 1.22\n");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("TypeScript"));
    assert.ok(data.stack.languages.includes("Python"));
    assert.ok(data.stack.languages.includes("Go"));
  });
});

describe("initOracleDeterministic - empty project", () => {
  it("returns empty stack for bare directory", () => {
    const data = initOracleDeterministic(PROJECT);
    assert.equal(data.stack.languages.length, 0);
    assert.equal(data.stack.frameworks.length, 0);
    assert.equal(data.stack.packageManager, null);
  });

  it("still writes oracle files", () => {
    initOracleDeterministic(PROJECT);
    assert.ok(oracleExists(PROJECT));
  });
});

// ---------------------------------------------------------------------------
// initOracleDeterministic - detectStructure
// ---------------------------------------------------------------------------

describe("initOracleDeterministic - structure detection", () => {
  it("lists root files and directories", () => {
    writeFileSync(join(PROJECT, "README.md"), "# Test");
    writeFileSync(join(PROJECT, "package.json"), "{}");
    mkdirSync(join(PROJECT, "src"));
    mkdirSync(join(PROJECT, "test"));
    mkdirSync(join(PROJECT, "docs"));

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.structure.rootFiles.includes("README.md"));
    assert.ok(data.structure.rootFiles.includes("package.json"));
    assert.ok(data.structure.directories.some(d => d.path === "src" && d.description === "source code"));
    assert.ok(data.structure.directories.some(d => d.path === "test" && d.description === "tests"));
    assert.ok(data.structure.directories.some(d => d.path === "docs" && d.description === "documentation"));
  });

  it("skips hidden dirs (except .github)", () => {
    mkdirSync(join(PROJECT, ".git"));
    mkdirSync(join(PROJECT, ".vscode"));
    mkdirSync(join(PROJECT, ".github"));
    mkdirSync(join(PROJECT, "src"));

    const data = initOracleDeterministic(PROJECT);
    const dirNames = data.structure.directories.map(d => d.path);
    assert.ok(!dirNames.includes(".git"));
    assert.ok(!dirNames.includes(".vscode"));
    assert.ok(dirNames.includes(".github"));
    assert.ok(dirNames.includes("src"));
  });

  it("skips node_modules, dist, build, __pycache__", () => {
    for (const skip of ["node_modules", "dist", "build", "__pycache__"]) {
      mkdirSync(join(PROJECT, skip));
    }
    mkdirSync(join(PROJECT, "src"));

    const data = initOracleDeterministic(PROJECT);
    const dirNames = data.structure.directories.map(d => d.path);
    assert.ok(!dirNames.includes("node_modules"));
    assert.ok(!dirNames.includes("dist"));
    assert.ok(!dirNames.includes("build"));
    assert.ok(!dirNames.includes("__pycache__"));
    assert.ok(dirNames.includes("src"));
  });

  it("detects entry points from package.json", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({
      main: "./dist/index.js",
      bin: { "my-cli": "./dist/cli.js" },
    }));

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.structure.entryPoints.includes("./dist/index.js"));
    assert.ok(data.structure.entryPoints.includes("./dist/cli.js"));
  });

  it("detects src/index.ts entry point", () => {
    mkdirSync(join(PROJECT, "src"));
    writeFileSync(join(PROJECT, "src", "index.ts"), "export {}");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.structure.entryPoints.includes("src/index.ts"));
  });

  it("recognizes directory purposes: bin, scripts, config, public, migrations, cmd, pkg, internal", () => {
    for (const dir of ["bin", "scripts", "config", "public", "migrations", "cmd", "pkg", "internal"]) {
      mkdirSync(join(PROJECT, dir));
    }
    const data = initOracleDeterministic(PROJECT);
    const lookup = new Map(data.structure.directories.map(d => [d.path, d.description]));
    assert.equal(lookup.get("bin"), "executables");
    assert.equal(lookup.get("scripts"), "build/dev scripts");
    assert.equal(lookup.get("config"), "configuration");
    assert.equal(lookup.get("public"), "static assets");
    assert.equal(lookup.get("migrations"), "database migrations");
    assert.equal(lookup.get("cmd"), "Go commands");
    assert.equal(lookup.get("pkg"), "Go packages");
    assert.equal(lookup.get("internal"), "Go internal");
  });

  it("unknown directory gets generic description", () => {
    mkdirSync(join(PROJECT, "something"));

    const data = initOracleDeterministic(PROJECT);
    const dir = data.structure.directories.find(d => d.path === "something");
    assert.ok(dir);
    assert.equal(dir.description, "project directory");
  });
});

// ---------------------------------------------------------------------------
// initOracleDeterministic - detectPatterns
// ---------------------------------------------------------------------------

describe("initOracleDeterministic - patterns detection", () => {
  it("includes CLAUDE.md content when present", () => {
    writeFileSync(join(PROJECT, "CLAUDE.md"), "# Agent Rules\nDo not push to main.");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.patterns.includes("CLAUDE.md"));
    assert.ok(data.patterns.includes("Do not push to main"));
  });

  it("detects editorconfig", () => {
    writeFileSync(join(PROJECT, ".editorconfig"), "root = true");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.patterns.includes("EditorConfig present"));
  });

  it("detects eslint configs", () => {
    writeFileSync(join(PROJECT, "eslint.config.js"), "module.exports = {}");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.patterns.includes("ESLint: eslint.config.js"));
  });

  it("detects eslintrc.json", () => {
    writeFileSync(join(PROJECT, ".eslintrc.json"), "{}");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.patterns.includes("ESLint: .eslintrc.json"));
  });

  it("detects prettier configs", () => {
    writeFileSync(join(PROJECT, ".prettierrc"), "{}");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.patterns.includes("Prettier: .prettierrc"));
  });

  it("truncates long CLAUDE.md at 3000 chars", () => {
    writeFileSync(join(PROJECT, "CLAUDE.md"), "X".repeat(5000));

    const data = initOracleDeterministic(PROJECT);
    // The pattern should contain max 3000 chars from CLAUDE.md
    const claudePart = data.patterns.split("From CLAUDE.md:\n")[1];
    assert.ok(claudePart);
    assert.ok(claudePart.length <= 3100); // some slack for prefix
  });
});

// ---------------------------------------------------------------------------
// initOracleDeterministic - detectGlossary
// ---------------------------------------------------------------------------

describe("initOracleDeterministic - glossary detection", () => {
  it("extracts project name from README.md heading", () => {
    writeFileSync(join(PROJECT, "README.md"), "# My Awesome Project\n\nSome description.");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.glossary.includes("My Awesome Project"));
  });

  it("returns empty when no README", () => {
    const data = initOracleDeterministic(PROJECT);
    assert.equal(data.glossary, "");
  });

  it("returns empty when README has no heading", () => {
    writeFileSync(join(PROJECT, "README.md"), "No heading here, just text.");

    const data = initOracleDeterministic(PROJECT);
    assert.equal(data.glossary, "");
  });
});

// ---------------------------------------------------------------------------
// initOracleDeterministic - workspace / subproject scanning
// ---------------------------------------------------------------------------

describe("initOracleDeterministic - workspace scanning", () => {
  it("scans subprojects when root has no languages", () => {
    // Root has no language markers
    // Subproject 1: TypeScript
    const sub1 = join(PROJECT, "sub-ts");
    mkdirSync(sub1);
    writeFileSync(join(sub1, "package.json"), JSON.stringify({
      dependencies: { typescript: "^5" },
    }));
    writeFileSync(join(sub1, "tsconfig.json"), "{}");

    // Subproject 2: Python
    const sub2 = join(PROJECT, "sub-py");
    mkdirSync(sub2);
    writeFileSync(join(sub2, "requirements.txt"), "fastapi\n");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("TypeScript"));
    assert.ok(data.stack.languages.includes("Python"));
  });

  it("skips hidden and excluded subdirs during scan", () => {
    mkdirSync(join(PROJECT, ".hidden"));
    writeFileSync(join(PROJECT, ".hidden", "package.json"), JSON.stringify({ dependencies: { express: "4" } }));

    mkdirSync(join(PROJECT, "node_modules"));
    writeFileSync(join(PROJECT, "node_modules", "package.json"), JSON.stringify({ dependencies: { express: "4" } }));

    const data = initOracleDeterministic(PROJECT);
    // Should not detect anything from hidden or node_modules
    assert.equal(data.stack.languages.length, 0);
  });

  it("does not scan subprojects when root already has languages", () => {
    // Root is a TypeScript project
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({ dependencies: { typescript: "^5" } }));
    writeFileSync(join(PROJECT, "tsconfig.json"), "{}");

    // Subproject has Python - should NOT be picked up
    const sub = join(PROJECT, "sub-py");
    mkdirSync(sub);
    writeFileSync(join(sub, "requirements.txt"), "django\n");

    const data = initOracleDeterministic(PROJECT);
    assert.ok(data.stack.languages.includes("TypeScript"));
    assert.ok(!data.stack.languages.includes("Python"));
  });

  it("annotates directory descriptions from subproject types", () => {
    const sub = join(PROJECT, "my-service");
    mkdirSync(sub);
    writeFileSync(join(sub, "package.json"), JSON.stringify({
      dependencies: { typescript: "^5", express: "^4" },
    }));
    writeFileSync(join(sub, "tsconfig.json"), "{}");

    const data = initOracleDeterministic(PROJECT);
    const dir = data.structure.directories.find(d => d.path === "my-service");
    assert.ok(dir);
    assert.ok(dir.description.includes("TypeScript"));
  });
});

// ---------------------------------------------------------------------------
// Oracle files persistence
// ---------------------------------------------------------------------------

describe("oracle files persistence", () => {
  it("initOracleDeterministic creates loadable files", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({
      dependencies: { typescript: "^5", react: "^18" },
    }));
    writeFileSync(join(PROJECT, "tsconfig.json"), "{}");

    initOracleDeterministic(PROJECT);

    // Files should be loadable
    const loaded = loadOracleFiles(PROJECT);
    assert.ok(loaded);
    assert.ok(loaded.stack.includes("TypeScript"));
    assert.ok(loaded.stack.includes("React"));

    // Context should work
    const ctx = oracleContext(PROJECT);
    assert.ok(ctx.includes("TypeScript"));

    // oracleExists should return true
    assert.ok(oracleExists(PROJECT));
  });

  it("formatted stack includes all detected info", () => {
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({
      engines: { node: ">=20" },
      dependencies: { typescript: "^5", next: "^14" },
      devDependencies: { esbuild: "^0.25", vitest: "^1" },
    }));
    writeFileSync(join(PROJECT, "tsconfig.json"), "{}");

    initOracleDeterministic(PROJECT);
    const loaded = loadOracleFiles(PROJECT);
    assert.ok(loaded);
    assert.ok(loaded.stack.includes("Languages: TypeScript"));
    assert.ok(loaded.stack.includes("Frameworks: Next.js"));
    assert.ok(loaded.stack.includes("Build: esbuild"));
    assert.ok(loaded.stack.includes("Test: Vitest"));
    assert.ok(loaded.stack.includes("Package manager: npm"));
    assert.ok(loaded.stack.includes("Node: >=20"));
  });
});
