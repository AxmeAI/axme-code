/**
 * Shared scope-restriction preamble for all four LLM scanners
 * (oracle, decision, safety, deploy).
 *
 * Why this exists: the Claude Agent SDK runs scanners with
 * `permissionMode: "bypassPermissions"` and `allowDangerouslySkipPermissions:
 * true` (see src/utils/agent-options.ts:278), which means Read/Glob/Grep/Bash
 * have NO path sandbox. The `cwd` option only sets a default working
 * directory; the LLM is still free to use absolute paths or `..` to read
 * anything on disk. On top of that, the `claude_code` system-prompt preset
 * cascades CLAUDE.md from the cwd upward to filesystem root by default —
 * so in a monorepo / multi-repo workspace layout (e.g.
 * `axme-workspace/CLAUDE.md` + `axme-workspace/<repo>/`), running setup
 * inside a child repo silently pulls the parent workspace context into
 * every scanner's view.
 *
 * Reported by @geobelsky 2026-05-16 after observing scanner output reference
 * sibling repos and the workspace-level CLAUDE.md when setup was supposed
 * to be repo-local.
 *
 * The fix is an explicit prompt-level constraint that the LLM is
 * instructed to honor. We can't enforce this at the tool layer (SDK has no
 * `restrictToCwd` flag), so we rely on the model following an unambiguous
 * boundary statement at the top of every scanner prompt.
 */

/**
 * Build a scope-restriction preamble for a scanner prompt.
 *
 * @param projectPath Absolute path of the project the scanner is initialising.
 *   Used both in the boundary statement and (optionally) to whitelist the
 *   Claude auto-memory path for that exact project.
 * @param opts.allowAutoMemoryRead When true, the preamble whitelists the
 *   `~/.claude/projects/<encoded-path>/memory/` location so the oracle
 *   scanner can read accumulated cross-session memories. Other scanners
 *   (decision/safety/deploy) don't need cross-project memory and leave
 *   this off.
 */
export function buildScopeConstraint(
  projectPath: string,
  opts: { allowAutoMemoryRead?: boolean } = {},
): string {
  const allowMemory = opts.allowAutoMemoryRead === true;
  // Compute the encoded project path the way the oracle prompt asks the LLM
  // to compute it — replace every non-alphanumeric char with "-". We
  // pre-compute it here so the whitelist is concrete (no LLM math required).
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, "-");
  const memoryClause = allowMemory
    ? `   - EXCEPTION: you MAY read \`~/.claude/projects/${encoded}/memory/\` ` +
      `and its contents (this is the auto-memory store for THIS project; reading it is required).\n`
    : "";

  return `## Scope boundary (read first — do not violate)

You are scanning a SINGLE project rooted at:

  ${projectPath}

You MUST keep every Read / Glob / Grep / Bash tool call strictly inside that directory tree.

- All file paths in your tool calls must be either relative paths that resolve inside ${projectPath} or absolute paths that start with that prefix.
- Do NOT use \`..\` to escape upward.
- Do NOT read or list any file in the parent of ${projectPath}, or in sibling directories, or in any unrelated location on the filesystem.
- Do NOT cd / chdir / pushd to anywhere outside ${projectPath}.
- If the \`claude_code\` system prompt mentions parent CLAUDE.md, repo siblings, or workspace-level files, IGNORE them. The user has explicitly asked you to confine analysis to ${projectPath}.
- If you encounter a symlink that points outside ${projectPath}, do not follow it.

${memoryClause}---

`;
}
