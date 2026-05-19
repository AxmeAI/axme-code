/**
 * Workspace detector - reliably identifies multi-repo workspaces.
 *
 * Checks 14 formats in priority order, from most explicit to heuristic:
 * 1. VS Code .code-workspace
 * 2. .NET .sln
 * 3. JetBrains .idea/modules.xml
 * 4. Sublime .sublime-project
 * 5. Rush rush.json
 * 6. pnpm pnpm-workspace.yaml
 * 7. npm/yarn package.json workspaces
 * 8. Lerna lerna.json
 * 9. Nx nx.json + project.json files
 * 10. Gradle settings.gradle(.kts)
 * 11. Maven pom.xml modules
 * 12. Git .gitmodules
 * 13. Heuristic: 2+ subdirs with .git/
 * 14. Single project
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import type { WorkspaceInfo, WorkspaceProject } from "../types.js";

/**
 * Detect workspace type and project list from a directory.
 *
 * Uses manifest-based detection first (VSCode, .sln, pnpm, etc.),
 * then ENRICHES with any git repos found on disk that aren't in the manifest.
 * This ensures no repo is missed even if the manifest is incomplete.
 */
export function detectWorkspace(cwd: string): WorkspaceInfo {
  const root = resolve(cwd);

  // Try manifest-based detectors in priority order
  const result =
    detectVSCodeWorkspace(root) ??
    detectDotnetSolution(root) ??
    detectJetBrains(root) ??
    detectSublime(root) ??
    detectRush(root) ??
    detectPnpmWorkspace(root) ??
    detectNpmWorkspace(root) ??
    detectLerna(root) ??
    detectNx(root) ??
    detectGradle(root) ??
    detectMaven(root) ??
    detectGitSubmodules(root) ??
    detectMultiGit(root);

  if (!result) {
    return { type: "single", root, projects: [{ path: ".", name: basename(root) }], manifestPath: null };
  }

  // Enrich: add any git repos found on disk that aren't in the manifest
  return enrichWithGitRepos(root, result);
}

/**
 * Scan for .git/ subdirectories and add any that are missing from the detected project list.
 */
function enrichWithGitRepos(root: string, ws: WorkspaceInfo): WorkspaceInfo {
  // Use a Set for O(1) dedup and normalize paths to bare entry names
  // (no leading ./ or .\\ or dir/ prefix — just the directory name).
  // Both POSIX `./packages` and Windows `.\\packages` need to collapse
  // to `packages`; previously the regex matched only `/`.
  const stripDotPrefix = (p: string): string => p.replace(/^\.[\\/]?/, "");
  const knownPaths = new Set(ws.projects.map(p => stripDotPrefix(p.path)));
  const newProjects = [...ws.projects];

  for (const entry of safeReaddir(root)) {
    if (entry.startsWith(".") || ["node_modules", "dist", "build", ".git"].includes(entry)) continue;
    const normalized = stripDotPrefix(entry);
    if (knownPaths.has(normalized)) continue;

    const entryPath = join(root, entry);
    if (isDir(entryPath) && existsSync(join(entryPath, ".git"))) {
      newProjects.push({ path: normalized, name: normalized });
      knownPaths.add(normalized);
    }
  }

  return { ...ws, projects: newProjects };
}

// --- Detectors ---

function detectVSCodeWorkspace(root: string): WorkspaceInfo | null {
  const files = safeReaddir(root).filter(f => f.endsWith(".code-workspace"));
  if (files.length === 0) return null;
  const filePath = join(root, files[0]);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const data = JSON.parse(cleaned);
    if (!data.folders || !Array.isArray(data.folders)) return null;
    const projects: WorkspaceProject[] = data.folders
      .map((f: any) => ({ path: f.path ?? ".", name: f.name ?? basename(f.path ?? ".") }))
      .filter((p: WorkspaceProject) => p.path !== ".");
    if (projects.length === 0) return null;
    return { type: "vscode", root, projects, manifestPath: filePath };
  } catch { return null; }
}

function detectDotnetSolution(root: string): WorkspaceInfo | null {
  const files = safeReaddir(root).filter(f => f.endsWith(".sln"));
  if (files.length === 0) return null;
  const filePath = join(root, files[0]);
  try {
    const content = readFileSync(filePath, "utf-8");
    const projectRegex = /Project\("[^"]*"\)\s*=\s*"([^"]*)",\s*"([^"]*)"/g;
    const solutionFolderGuid = "2150E333-8FDC-42A3-9474-1A3956D46DE8";
    const projects: WorkspaceProject[] = [];
    let match;
    while ((match = projectRegex.exec(content)) !== null) {
      if (content.substring(match.index - 40, match.index).includes(solutionFolderGuid)) continue;
      const name = match[1];
      const projPath = match[2].replace(/\\/g, "/");
      const dir = dirname(projPath);
      if (dir && dir !== "." && !projects.some(p => p.path === dir)) {
        projects.push({ path: dir, name });
      }
    }
    if (projects.length < 2) return null;
    return { type: "dotnet", root, projects, manifestPath: filePath };
  } catch { return null; }
}

function detectJetBrains(root: string): WorkspaceInfo | null {
  const modulesPath = join(root, ".idea", "modules.xml");
  if (!existsSync(modulesPath)) return null;
  try {
    const content = readFileSync(modulesPath, "utf-8");
    const moduleRegex = /filepath="\$PROJECT_DIR\$\/([^"]+\.iml)"/g;
    const projects: WorkspaceProject[] = [];
    let match;
    while ((match = moduleRegex.exec(content)) !== null) {
      const dir = dirname(match[1]);
      if (dir && dir !== "." && !projects.some(p => p.path === dir)) {
        projects.push({ path: dir, name: basename(dir) });
      }
    }
    if (projects.length < 2) return null;
    return { type: "jetbrains", root, projects, manifestPath: modulesPath };
  } catch { return null; }
}

function detectSublime(root: string): WorkspaceInfo | null {
  const files = safeReaddir(root).filter(f => f.endsWith(".sublime-project"));
  if (files.length === 0) return null;
  const filePath = join(root, files[0]);
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!data.folders || !Array.isArray(data.folders)) return null;
    const projects: WorkspaceProject[] = data.folders
      .filter((f: any) => f.path && f.path !== ".")
      .map((f: any) => ({ path: f.path, name: f.name ?? basename(f.path) }));
    if (projects.length < 2) return null;
    return { type: "sublime", root, projects, manifestPath: filePath };
  } catch { return null; }
}

function detectRush(root: string): WorkspaceInfo | null {
  const filePath = join(root, "rush.json");
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!data.projects || !Array.isArray(data.projects)) return null;
    const projects: WorkspaceProject[] = data.projects.map((p: any) => ({
      path: p.projectFolder, name: p.packageName ?? basename(p.projectFolder),
    }));
    if (projects.length < 2) return null;
    return { type: "rush", root, projects, manifestPath: filePath };
  } catch { return null; }
}

function detectPnpmWorkspace(root: string): WorkspaceInfo | null {
  const filePath = join(root, "pnpm-workspace.yaml");
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const packagesMatch = content.match(/packages:\s*\n((?:\s+-\s+.+\n?)*)/);
    if (!packagesMatch) return null;
    const globs = packagesMatch[1].split("\n")
      .map(line => line.replace(/^\s*-\s*['"]?/, "").replace(/['"]?\s*$/, "").trim())
      .filter(Boolean).filter(g => !g.startsWith("!"));
    const projects = resolveGlobs(root, globs);
    if (projects.length < 2) return null;
    return { type: "pnpm", root, projects, manifestPath: filePath };
  } catch { return null; }
}

function detectNpmWorkspace(root: string): WorkspaceInfo | null {
  const filePath = join(root, "package.json");
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!data.workspaces) return null;
    const globs = Array.isArray(data.workspaces) ? data.workspaces : data.workspaces.packages ?? [];
    if (globs.length === 0) return null;
    const projects = resolveGlobs(root, globs);
    if (projects.length < 2) return null;
    return { type: "npm", root, projects, manifestPath: filePath };
  } catch { return null; }
}

function detectLerna(root: string): WorkspaceInfo | null {
  const filePath = join(root, "lerna.json");
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    const globs = data.packages ?? ["packages/*"];
    const projects = resolveGlobs(root, globs);
    if (projects.length < 2) return null;
    return { type: "lerna", root, projects, manifestPath: filePath };
  } catch { return null; }
}

function detectNx(root: string): WorkspaceInfo | null {
  if (!existsSync(join(root, "nx.json"))) return null;
  const projects: WorkspaceProject[] = [];
  for (const dir of ["apps", "packages", "libs", "projects"]) {
    const fullDir = join(root, dir);
    if (!existsSync(fullDir)) continue;
    for (const entry of safeReaddir(fullDir)) {
      if (existsSync(join(fullDir, entry, "project.json"))) {
        projects.push({ path: join(dir, entry), name: entry });
      }
    }
  }
  for (const entry of safeReaddir(root)) {
    if (entry.startsWith(".") || ["node_modules", "dist", "build"].includes(entry)) continue;
    const entryPath = join(root, entry);
    if (isDir(entryPath) && existsSync(join(entryPath, "project.json")) && !projects.some(p => p.path === entry)) {
      projects.push({ path: entry, name: entry });
    }
  }
  if (projects.length < 2) return null;
  return { type: "nx", root, projects, manifestPath: join(root, "nx.json") };
}

function detectGradle(root: string): WorkspaceInfo | null {
  const groovyPath = join(root, "settings.gradle");
  const kotlinPath = join(root, "settings.gradle.kts");
  const filePath = existsSync(groovyPath) ? groovyPath : existsSync(kotlinPath) ? kotlinPath : null;
  if (!filePath) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const includeRegex = /include\s*\(?([^)]+)\)?/g;
    const projects: WorkspaceProject[] = [];
    let match;
    while ((match = includeRegex.exec(content)) !== null) {
      const modules = match[1].split(/[,\n]/).map(m => m.replace(/['":\s]/g, "").trim()).filter(Boolean);
      for (const mod of modules) {
        const path = mod.replace(/:/g, "/");
        if (path && !projects.some(p => p.path === path)) {
          projects.push({ path, name: basename(path) });
        }
      }
    }
    if (projects.length < 2) return null;
    return { type: "gradle", root, projects, manifestPath: filePath };
  } catch { return null; }
}

function detectMaven(root: string): WorkspaceInfo | null {
  const filePath = join(root, "pom.xml");
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const moduleRegex = /<module>([^<]+)<\/module>/g;
    const projects: WorkspaceProject[] = [];
    let match;
    while ((match = moduleRegex.exec(content)) !== null) {
      const path = match[1].trim();
      if (path && !projects.some(p => p.path === path)) {
        projects.push({ path, name: basename(path) });
      }
    }
    if (projects.length < 2) return null;
    return { type: "maven", root, projects, manifestPath: filePath };
  } catch { return null; }
}

function detectGitSubmodules(root: string): WorkspaceInfo | null {
  const filePath = join(root, ".gitmodules");
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const pathRegex = /path\s*=\s*(.+)/g;
    const projects: WorkspaceProject[] = [];
    let match;
    while ((match = pathRegex.exec(content)) !== null) {
      const path = match[1].trim();
      if (path) projects.push({ path, name: basename(path) });
    }
    if (projects.length < 2) return null;
    return { type: "submodules", root, projects, manifestPath: filePath };
  } catch { return null; }
}

function detectMultiGit(root: string): WorkspaceInfo | null {
  const projects: WorkspaceProject[] = [];
  for (const entry of safeReaddir(root)) {
    if (entry.startsWith(".") || ["node_modules", "dist", "build", ".git"].includes(entry)) continue;
    const entryPath = join(root, entry);
    if (isDir(entryPath) && existsSync(join(entryPath, ".git"))) {
      projects.push({ path: entry, name: entry });
    }
  }
  if (projects.length < 2) return null;
  return { type: "multi-git", root, projects, manifestPath: null };
}

// --- Helpers ---

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function resolveGlobs(root: string, globs: string[]): WorkspaceProject[] {
  const projects: WorkspaceProject[] = [];
  for (const glob of globs) {
    if (glob.endsWith("/*") || glob.endsWith("/**") || glob.endsWith("\\*") || glob.endsWith("\\**")) {
      // Strip trailing `/*`, `/**`, `\*`, or `\**` from the glob.
      // Workspace manifests (pnpm-workspace.yaml, package.json workspaces)
      // sometimes ship with Windows-style separators when authored on
      // Windows; previously the regex matched only `/`.
      const dir = glob.replace(/[\\/]\*\*?$/, "");
      const fullDir = join(root, dir);
      if (!existsSync(fullDir)) continue;
      for (const entry of safeReaddir(fullDir)) {
        const entryPath = join(fullDir, entry);
        if (!isDir(entryPath)) continue;
        if (existsSync(join(entryPath, "package.json"))) {
          const path = join(dir, entry);
          if (!projects.some(p => p.path === path)) {
            projects.push({ path, name: entry });
          }
        }
      }
    } else {
      const fullPath = join(root, glob);
      if (existsSync(fullPath) && isDir(fullPath)) {
        if (!projects.some(p => p.path === glob)) {
          projects.push({ path: glob, name: basename(glob) });
        }
      }
    }
  }
  return projects;
}
