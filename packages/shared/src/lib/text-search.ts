/**
 * Text matching used by every user-facing search.
 *
 * The default mode is case- and diacritic-insensitive, so a query such as
 * `nina` matches `Niña`. Case-sensitive callers retain literal substring
 * matching, including accents.
 */

const COMBINING_MARKS = /\p{M}/gu;
const IS_COMBINING_MARK = /^\p{M}$/u;

export interface TextSearchMatch {
  /** UTF-16 offsets in the original text, suitable for String#slice. */
  start: number;
  end: number;
}

export function normalizeSearchText(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

export function includesSearchText(
  haystack: string,
  query: string,
  caseSensitive = false,
): boolean {
  if (caseSensitive) return haystack.includes(query);
  return normalizeSearchText(haystack).includes(normalizeSearchText(query));
}

/**
 * Finds all non-overlapping matches and returns offsets into the original
 * string. The mapping keeps combining marks with their base character, so a
 * match for `cafe` highlights the complete `café` in either composed or
 * decomposed Unicode input.
 */
export function findTextSearchMatches(
  haystack: string,
  query: string,
  caseSensitive = false,
): TextSearchMatch[] {
  if (!query) return [];

  if (caseSensitive) return findLiteralMatches(haystack, query);

  const needle = normalizeSearchText(query);
  if (!needle) return [];

  const normalized: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;

  while (offset < haystack.length) {
    const start = offset;
    const first = String.fromCodePoint(haystack.codePointAt(offset)!);
    offset += first.length;

    // Include any following combining marks in this source-character range.
    while (offset < haystack.length) {
      const next = String.fromCodePoint(haystack.codePointAt(offset)!);
      if (!IS_COMBINING_MARK.test(next)) break;
      offset += next.length;
    }

    const folded = normalizeSearchText(haystack.slice(start, offset));
    for (let i = 0; i < folded.length; i++) {
      normalized.push(folded[i]);
      starts.push(start);
      ends.push(offset);
    }
  }

  const normalizedHaystack = normalized.join('');
  const matches: TextSearchMatch[] = [];
  let from = 0;
  while (true) {
    const index = normalizedHaystack.indexOf(needle, from);
    if (index === -1) return matches;
    matches.push({ start: starts[index], end: ends[index + needle.length - 1] });
    from = index + needle.length;
  }
}

function findLiteralMatches(haystack: string, query: string): TextSearchMatch[] {
  const matches: TextSearchMatch[] = [];
  let from = 0;
  while (true) {
    const start = haystack.indexOf(query, from);
    if (start === -1) return matches;
    matches.push({ start, end: start + query.length });
    from = start + query.length;
  }
}
