/**
 * Pagination utility for MCP tool outputs.
 *
 * Splits content into pages by logical sections to prevent
 * MCP output truncation. Each page includes navigation instructions
 * telling the agent to call the tool again with the next page number.
 */

/** Default character limit per page (well under MCP truncation threshold). */
export const DEFAULT_PAGE_CHAR_LIMIT = 25_000;

export interface PaginatedOutput {
  text: string;
  page: number;
  totalPages: number;
}

/**
 * Paginate an array of text sections.
 *
 * Keeps sections intact (never splits mid-section).
 * Returns the requested page with navigation footer.
 *
 * @param sections - Logical content blocks (each becomes an atomic unit)
 * @param page - Requested page number (1-based, clamped to valid range)
 * @param toolName - MCP tool name for the "call next" instruction
 * @param toolArgs - Current tool arguments (page will be overridden)
 * @param charLimit - Max characters per page
 */
export function paginateSections(
  sections: string[],
  page: number,
  toolName: string,
  toolArgs: Record<string, unknown>,
  charLimit: number = DEFAULT_PAGE_CHAR_LIMIT,
): PaginatedOutput {
  // Fast path: everything fits in one page
  const total = sections.reduce((sum, s) => sum + s.length, 0);
  if (total <= charLimit) {
    return { text: sections.join("\n\n"), page: 1, totalPages: 1 };
  }

  // Sections larger than a whole page are split first. Without this a
  // caller like axme_memories — which passes ["## Project Memories", <one
  // 60KB block>] — produced a page 1 holding nothing but the heading, with
  // all content pushed to page 2. The reader sees "Page 1/3" and an empty
  // body, which reads as a bug in the data rather than in the packing.
  const units = sections.flatMap(s => (s.length > charLimit ? splitSection(s, charLimit) : [s]));

  // Build pages by packing sections until limit
  const pages: string[][] = [[]];
  let currentSize = 0;
  let idx = 0;

  for (const section of units) {
    // Start new page if adding this section exceeds limit AND page isn't empty
    if (currentSize + section.length > charLimit && pages[idx].length > 0) {
      idx++;
      pages.push([]);
      currentSize = 0;
    }
    pages[idx].push(section);
    currentSize += section.length;
  }

  const totalPages = pages.length;
  const safePage = Math.max(1, Math.min(page, totalPages));
  const content = pages[safePage - 1].join("\n\n");

  // Navigation footer
  let footer = "";
  if (safePage < totalPages) {
    const nextArgs = { ...toolArgs, page: safePage + 1 };
    const argsStr = Object.entries(nextArgs)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
    footer = `\n\n---\n**Page ${safePage}/${totalPages}** - call \`${toolName}\` with \`{ ${argsStr} }\` to load next page.`;
  } else if (totalPages > 1) {
    footer = `\n\n---\n**Page ${safePage}/${totalPages}** - all content loaded.`;
  }

  return { text: content + footer, page: safePage, totalPages };
}

/**
 * Split one oversized section into page-sized chunks along line boundaries.
 *
 * Line-aligned so a catalog entry, a table row, or a markdown heading is
 * never cut mid-token. A single line longer than the limit (a pathological
 * one-line blob) is emitted as its own chunk rather than being truncated —
 * pagination must never lose content, only distribute it.
 */
function splitSection(section: string, charLimit: number): string[] {
  const lines = section.split("\n");
  const chunks: string[] = [];
  let buf: string[] = [];
  let size = 0;

  for (const line of lines) {
    // +1 for the newline that rejoining will add back.
    const cost = line.length + 1;
    if (size + cost > charLimit && buf.length > 0) {
      chunks.push(buf.join("\n"));
      buf = [];
      size = 0;
    }
    buf.push(line);
    size += cost;
  }
  if (buf.length > 0) chunks.push(buf.join("\n"));
  return chunks.length > 0 ? chunks : [section];
}
