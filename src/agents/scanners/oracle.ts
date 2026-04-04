/**
 * Oracle Scanner Agent - read-only LLM agent that scans a project
 * and produces rich knowledge base files.
 *
 * Model: Sonnet (needs code understanding)
 * Tools: Read, Glob, Grep, Bash (read-only)
 * Budget: $1 max (typical $0.20-0.50)
 */

import type { OracleFiles } from "../../types.js";
import { extractCostFromResult, zeroCost, type CostInfo } from "../../utils/cost-extractor.js";
import { buildAgentQueryOptions } from "../../utils/agent-options.js";

export interface OracleScanResult {
  files: OracleFiles;
  cost: CostInfo;
  durationMs: number;
}

const ORACLE_SCAN_PROMPT = `You are a project analyst. Your job is to scan this codebase and produce a comprehensive knowledge base.

## Instructions

Thoroughly scan the project using the tools available to you. Read files, explore the directory structure, and understand the codebase deeply.

**What to scan (check all that exist):**

1. **Package manifests:** package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml, *.csproj, Gemfile, composer.json
2. **README and docs:** README.md, ARCHITECTURE.md, docs/, docs/adr/, docs/design/, docs/rfcs/
3. **AI agent instructions (CRITICAL - read FULLY and extract ALL rules):**
   - CLAUDE.md (root level) - read COMPLETELY, not just skim
   - .claude/CLAUDE.md (alternative location)
   - .claude/rules/*.md (path-scoped rules)
   - .claudecode/rules.md
   - AGENTS.md (cross-tool standard)
   - GEMINI.md, .cursorrules, .cursor/rules/*.mdc
   - .windsurfrules, .windsurf/rules/*.md
   - .clinerules, .clinerules/*.md
   - .continue/rules/*.md, .continuerules
   - .amazonq/rules/*.md, .junie/guidelines.md
   - .augment/rules/*.md, .roo/rules/*.md, .goosehints
   - **If CLAUDE.md references other files** (e.g. "read agent_onboarding/RULES.md first") - **follow those references and read them too**
   - Check subdirectories for additional CLAUDE.md files
4. **Claude auto-memory (accumulated project knowledge):**
   - Compute the encoded project path: replace every non-alphanumeric char in the absolute project path with "-"
   - Check ~/.claude/projects/<encoded-path>/memory/MEMORY.md
   - Read ALL .md files in ~/.claude/projects/<encoded-path>/memory/
   - These contain hard-won operational lessons - treat as HIGH PRIORITY
5. **Config files:** tsconfig.json, .eslintrc*, eslint.config.*, .prettierrc*, .editorconfig, Makefile, Taskfile.yml, Justfile
6. **Source directory structure** (list all significant directories and their contents)
7. **Sample source files** (read 3-5 key files to understand patterns)
8. **Test structure** (what testing framework, where tests live, test conventions)
9. **CI/CD config:** .github/workflows/*.yml, .gitlab-ci.yml, Jenkinsfile, .circleci/config.yml, bitbucket-pipelines.yml
10. **Container/infra:** Dockerfile, docker-compose.yml, k8s/, terraform/
11. **Git history** (recent commits to understand activity)
12. **Code quality:** .pre-commit-config.yaml, .husky/, .lefthook.yml, CODEOWNERS, .github/CODEOWNERS
13. **Deploy/checklist files:** *CHECKLIST*, *PRE_PROD*, *pre-deploy* (extract deploy procedures)

**Important:** Be thorough. Read actual source files, not just manifests.
If AI agent instruction files exist (CLAUDE.md, AGENTS.md, etc.), treat their content as the HIGHEST PRIORITY source - these contain rules that OVERRIDE default behavior.
If Claude auto-memory exists, treat it as HIGH PRIORITY - it contains operational lessons from real incidents.

## Output Format

Produce your output in EXACTLY this format with these section markers. Each section is the content for one oracle file.

===STACK===
Write a detailed description of the tech stack:
- Languages with versions and their role in the project
- Frameworks with versions and what they're used for
- Build tools and their configuration
- Test frameworks and runners
- Package manager
- Runtime requirements (Node version, Python version, etc.)
- Key dependencies and what they do

Write in markdown. Be specific about versions and roles, not just names.

===STRUCTURE===
Write a detailed project structure guide:
- For each significant directory: path, purpose, key files, and how it relates to other parts
- Entry points (main files, CLI entry, server start)
- How the code is organized (by feature, by layer, by domain, etc.)
- Important files at the root level and their purpose

Write in markdown. Include enough detail that someone new could navigate the project.

===PATTERNS===
Write about coding conventions and patterns found in the code:
- Naming conventions (files, functions, variables, types)
- Error handling patterns
- Test patterns (how tests are structured, naming, what's tested)
- Import/module organization
- Code style (from config files and actual code)
- API/interface patterns
- Rules from AI agent files (CLAUDE.md, AGENTS.md, .cursorrules, etc.) - reproduce important rules
- Git workflow rules (from CODEOWNERS, branch protection, CI checks)
- Safety rules and constraints (from any source)

Write in markdown. Include concrete examples from the actual code where helpful.
If CLAUDE.md, AGENTS.md, or similar files exist, their rules are the MOST IMPORTANT part of this section.

===GLOSSARY===
Write a glossary of project-specific terms:
- Domain terms used in the code and docs
- Abbreviations and acronyms
- Key concepts that someone new would need to understand
- Relationships between concepts

Write in markdown as a definition list. Include terms from README, source code, and documentation.

===END===`;

/**
 * Run the oracle LLM scan agent on a project.
 */
export async function runOracleScan(opts: {
  projectPath: string;
  model?: string;
  budgetUsd?: number;
  workspaceMode?: boolean;
  customPaths?: string[];
}): Promise<OracleScanResult> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const startTime = Date.now();
  const model = opts.model ?? "claude-sonnet-4-6";
  const budgetUsd = opts.budgetUsd ?? 1;

  const queryOpts = buildAgentQueryOptions(
    { cwd: opts.projectPath, model, budgetUsd },
    "scanner",
  );

  let prompt = ORACLE_SCAN_PROMPT;

  if (opts.workspaceMode) {
    prompt += `\n\n## WORKSPACE MODE - IMPORTANT
This is a WORKSPACE root containing multiple projects/repos. DO NOT deep-dive into each project's source code.

For the workspace scan, ONLY look at:
- Root-level files: CLAUDE.md, README.md, *.code-workspace, docker-compose.yml, Makefile
- Each project's top-level: README.md, package.json/go.mod/pyproject.toml (for stack detection)
- Shared configs: .github/workflows/ at root level
- Relationships between projects (which depends on which)

DO NOT read source code inside projects (src/, services/, cmd/, etc.) - that will be done in per-project scans.

Focus the STRUCTURE section on listing all projects and their roles/relationships.
Focus the PATTERNS section on workspace-wide conventions (git workflow, release process, naming).`;
  }

  prompt += `\n\n## Process\nAs you scan, briefly describe what you're finding. Show your reasoning as you go.`;

  if (opts.customPaths?.length) {
    prompt += `\n\n## Additional Locations\nRead these additional paths if they exist:\n${opts.customPaths.map(p => `- ${p}`).join("\n")}`;
  }

  const q = sdk.query({ prompt, options: queryOpts });

  let result = "";
  let cost: CostInfo | undefined;

  for await (const msg of q) {
    if (msg.type === "assistant") {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) result += block.text;
        }
      }
    }
    if (msg.type === "result") {
      cost = extractCostFromResult(msg);
      if ((msg as any).subtype === "success" && (msg as any).result) {
        result = (msg as any).result;
      }
    }
  }

  const files = parseOracleOutput(result);
  if (!cost) cost = zeroCost();

  return { files, cost, durationMs: Date.now() - startTime };
}

/**
 * Parse structured oracle output into individual file contents.
 */
export function parseOracleOutput(output: string): OracleFiles {
  const sections: Record<string, string> = {};
  const markers = ["STACK", "STRUCTURE", "PATTERNS", "GLOSSARY"];

  for (let i = 0; i < markers.length; i++) {
    const startMarker = `===${markers[i]}===`;
    const endMarker = i < markers.length - 1 ? `===${markers[i + 1]}===` : "===END===";
    const startIdx = output.indexOf(startMarker);
    if (startIdx === -1) continue;
    const contentStart = startIdx + startMarker.length;
    const endIdx = output.indexOf(endMarker, contentStart);
    sections[markers[i].toLowerCase()] = (endIdx === -1
      ? output.slice(contentStart) : output.slice(contentStart, endIdx)).trim();
  }

  return {
    stack: sections.stack || "No stack information detected.",
    structure: sections.structure || "No structure information detected.",
    patterns: sections.patterns || "No patterns detected.",
    glossary: sections.glossary || "No glossary entries.",
  };
}
