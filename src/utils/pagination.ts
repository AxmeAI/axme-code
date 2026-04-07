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

  // Build pages by packing sections until limit
  const pages: string[][] = [[]];
  let currentSize = 0;
  let idx = 0;

  for (const section of sections) {
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
