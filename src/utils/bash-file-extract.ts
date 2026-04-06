/**
 * Extract file paths that a bash command writes to.
 *
 * Used by session-cleanup to supplement filesChanged with paths that
 * were mutated via Bash tool (echo > file, sed -i, cp, mv, rm, etc.)
 * but not tracked by PostToolUse (which only fires for Edit/Write).
 *
 * Regex-based extraction — covers ~90% of real agent patterns.
 * Does not attempt to be a full shell parser.
 */

/** Pseudo-paths that are never real files. */
const IGNORED_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "-", ""]);

/** Patterns that extract written-to file paths from bash commands. */
const WRITE_PATTERNS: Array<{ regex: RegExp; group: number }> = [
  // Redirect: cmd > path, cmd >> path, cmd 2> path, cmd &> path
  { regex: /(?:>>?|[12&]>)\s*(\S+)/g, group: 1 },
  // tee: cmd | tee path, tee -a path
  { regex: /\btee\s+(?:-[a-zA-Z]+\s+)*(\S+)/g, group: 1 },
  // sed -i: sed -i 's/a/b/' path (last non-flag arg after -i)
  { regex: /\bsed\s+(?:-[a-zA-Z.]+\s+)*(?:'[^']*'\s+|"[^"]*"\s+)*(\S+)\s*$/gm, group: 1 },
  // cp dst: cp [flags] src dst — last arg is destination
  { regex: /\bcp\s+(?:-[a-zA-Z]+\s+)*\S+\s+(\S+)\s*$/gm, group: 1 },
  // mv dst: mv [flags] src dst
  { regex: /\bmv\s+(?:-[a-zA-Z]+\s+)*\S+\s+(\S+)\s*$/gm, group: 1 },
  // rm: rm [flags] path [path...]
  { regex: /\brm\s+(?:-[a-zA-Z]+\s+)*(\S+)/g, group: 1 },
  // touch: touch path
  { regex: /\btouch\s+(\S+)/g, group: 1 },
  // mkdir: mkdir [flags] path
  { regex: /\bmkdir\s+(?:-[a-zA-Z]+\s+)*(\S+)/g, group: 1 },
  // chmod/chown: chmod 755 path, chown user:group path
  { regex: /\bch(?:mod|own)\s+\S+\s+(\S+)/g, group: 1 },
  // curl -o: curl -o path URL
  { regex: /\bcurl\s+.*?-[oO]\s+(\S+)/g, group: 1 },
  // wget -O: wget -O path URL
  { regex: /\bwget\s+.*?-O\s+(\S+)/g, group: 1 },
];

/**
 * Extract file paths written by a bash command.
 * Returns deduplicated array of paths. Filters out pseudo-paths
 * (/dev/null, -, variable paths like $VAR).
 */
export function extractBashWritePaths(command: string): string[] {
  // Process each segment of a compound command separately
  const segments = command.split(/[;&|]+/);
  const paths = new Set<string>();

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    for (const { regex, group } of WRITE_PATTERNS) {
      // Reset regex state for each segment (global flag)
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(trimmed)) !== null) {
        let p = match[group];
        if (!p) continue;
        // Strip surrounding quotes
        if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
          p = p.slice(1, -1);
        }
        // Skip pseudo-paths, variable paths, flags
        if (IGNORED_PATHS.has(p)) continue;
        if (p.startsWith("$") || p.startsWith("-")) continue;
        if (p.includes("${")) continue;
        paths.add(p);
      }
    }
  }
  return Array.from(paths);
}
