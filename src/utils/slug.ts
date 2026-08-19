/**
 * Slug generation for memory and decision filenames.
 *
 * Why this module exists: the original implementation was
 * `text.toLowerCase().replace(/[^a-z0-9]+/g, "-")`, which maps ANY
 * non-Latin title to the empty string. An empty slug produced the file
 * `.md` — a dotfile, invisible to `ls` and to every `memory/<type>/*.md`
 * glob in this codebase — and the NEXT non-Latin title overwrote it.
 * That is silent data loss, observed in the wild on a Cyrillic-language
 * project (4 affected files, 2 confirmed overwrites).
 *
 * Guarantees provided here:
 *   1. Never empty. Cyrillic and Greek transliterate; anything else that
 *      still reduces to nothing falls back to a content hash.
 *   2. Never degenerate. A slug of only digits and hyphens ("3", "16-07")
 *      carries no meaning for semantic search, so it gets a prefix.
 *   3. Stable. The same title always yields the same slug, so re-saving a
 *      memory updates it in place instead of accumulating near-duplicates.
 */

import { createHash } from "node:crypto";

/** Maximum slug length (memories historically allowed 60, decisions 50). */
export const DEFAULT_SLUG_MAX = 60;

/**
 * Cyrillic → Latin. Deliberately a plain lookup table rather than a
 * dependency: transliteration only has to be stable and readable, not
 * linguistically perfect, and adding a package for it would bloat the
 * bundle for a ~40-entry map.
 */
const CYRILLIC_MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
  з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
  ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
  я: "ya",
  // Ukrainian / Belarusian extras — cheap to include, avoids empty slugs
  // for the same class of titles.
  і: "i", ї: "yi", є: "ye", ґ: "g", ў: "u",
};

const GREEK_MAP: Record<string, string> = {
  α: "a", β: "b", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th",
  ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p",
  ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps",
  ω: "o",
};

/**
 * Transliterate non-Latin characters that have a well-known Latin form,
 * and strip diacritics from Latin ones (é → e) via NFD normalization.
 */
export function transliterate(text: string): string {
  const lowered = text.toLowerCase();
  let out = "";
  for (const ch of lowered) {
    out += CYRILLIC_MAP[ch] ?? GREEK_MAP[ch] ?? ch;
  }
  // Decompose accented Latin (é → e + combining acute) and drop the marks.
  return out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** A slug is degenerate when it carries no searchable word — only digits. */
export function isDegenerateSlug(slug: string): boolean {
  if (!slug) return true;
  return !/[a-z]/.test(slug);
}

/**
 * Build a filesystem-safe slug that is guaranteed non-empty and
 * non-degenerate.
 *
 * @param text     Source title.
 * @param maxLen   Truncation length.
 * @param prefix   Used when the title reduces to nothing or to digits only;
 *                 keeps hashed slugs distinguishable by kind ("memory-a1b2c3").
 */
export function makeSlug(text: string, maxLen = DEFAULT_SLUG_MAX, prefix = "entry"): string {
  const base = transliterate(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    // Truncation can leave a trailing hyphen ("foo-bar-" from "foo-bar-baz").
    .replace(/-+$/g, "");

  if (!base) {
    // Nothing survived transliteration (CJK, emoji-only, symbols). Hash the
    // ORIGINAL text so two different such titles never collide.
    return `${prefix}-${shortHash(text)}`;
  }

  if (isDegenerateSlug(base)) {
    // "16-07" or "3" — valid as a filename but useless for search and prone
    // to collision across unrelated entries. Prefix it into a real word.
    return `${prefix}-${base}`.slice(0, maxLen).replace(/-+$/g, "");
  }

  return base;
}

/** First 8 hex chars of sha1 — enough to separate titles, short enough to read. */
export function shortHash(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 8);
}
