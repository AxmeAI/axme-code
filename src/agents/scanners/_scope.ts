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

${memoryClause}## Sensitive paths — never read, never include

The following locations frequently contain plaintext secrets (API keys, passwords, tokens, private keys, cloud credentials). They may exist inside ${projectPath} regardless of the project's \`.gitignore\`. You MUST NOT Read, Glob, Grep, or cat these — and if you incidentally see their contents in any other tool's output, you MUST NOT echo, summarise, paraphrase, or include those contents in your final report.

Directory names (anywhere in the tree):
- \`credentials/\`, \`secrets/\`, \`keys/\`, \`certs/\`, \`private/\`
- \`.aws/\`, \`.ssh/\`, \`.gnupg/\`, \`.docker/\`
- \`.kube/\` (kubeconfig leaks cluster admin creds)

File patterns (anywhere in the tree):
- \`.env\`, \`.env.*\` (including \`.env.local\`, \`.env.production\`, etc.) — note \`.env.example\` / \`.env.template\` ARE safe to read, only the populated variants are sensitive
- \`*.pem\`, \`*.key\`, \`*.p12\`, \`*.pfx\`, \`*.jks\`, \`*.keystore\` — TLS / PKCS / Java keystore material
- \`id_rsa\`, \`id_dsa\`, \`id_ecdsa\`, \`id_ed25519\` (with or without \`.pub\` — though \`.pub\` files are technically safe, treat the whole family as off-limits)
- \`service-account*.json\`, \`gcp-key*.json\`, \`firebase-adminsdk*.json\` — GCP / Firebase service account keys
- \`.npmrc\`, \`.pypirc\`, \`.netrc\`, \`.pgpass\`, \`.git-credentials\` — package-registry / DB / git credential files
- \`secrets.yml\`, \`secrets.yaml\`, \`secret-*.json\`, \`config/master.key\` (Rails) — common explicit secret files

What you SHOULD still do:
- Note the EXISTENCE of these files (e.g. "project uses .env for configuration" or "AWS credentials present at .aws/credentials") in STACK / safety output — existence is useful context, contents are not.
- Read \`.gitignore\` itself to see what the project considers sensitive; if you see additional secret-like patterns there beyond this list, treat those paths as sensitive too.
- Read \`.env.example\` / \`.env.template\` / \`.env.sample\` — these document required env vars without populated values.

If asked to fill out a STACK / DEPENDENCIES / SECURITY section that references credentials, write "uses [service X] — credentials provisioned via .env / .aws / etc." and stop. Do NOT include the actual values.

---

`;
}
