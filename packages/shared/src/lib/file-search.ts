export interface FileSearchScore {
  score: number;
  indices: number[];
}

/**
 * Reconstruct display-only fuzzy match indices when the search backend does not
 * expose them. Prefer matches wholly inside the filename so a path match does
 * not produce a misleading partial filename highlight.
 */
export function fileSearchHighlightIndices(path: string, query: string): number[] {
  const normalizedPath = path.toLocaleLowerCase();
  const needle = Array.from(query.trim().toLocaleLowerCase())
    .filter((character) => !/\s/u.test(character))
    .join('');
  if (!needle) return [];

  const filenameStart = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  const filenameMatch = fuzzyMatchIndices(normalizedPath.slice(filenameStart), needle);
  if (filenameMatch) return filenameMatch.map((index) => filenameStart + index);

  return fuzzyMatchIndices(normalizedPath, needle) ?? [];
}

function fuzzyMatchIndices(haystack: string, needle: string): number[] | null {
  const contiguousStart = haystack.indexOf(needle);
  if (contiguousStart !== -1) {
    return Array.from({ length: needle.length }, (_, index) => contiguousStart + index);
  }

  const indices: number[] = [];
  let cursor = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    indices.push(found);
    cursor = found + 1;
  }
  return indices;
}

/**
 * Score one repository-relative path with the exact algorithm used by Ctrl+P.
 * The caller is responsible for applying smart-case normalization consistently
 * to both `haystack` and `needle`.
 */
export function scoreFilePath(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
): FileSearchScore | null {
  if (needle.length === 0) return { score: 0, indices: [] };

  const filenameStart = haystack.lastIndexOf('/') + 1;

  // Quick reject: each character of the query must appear in order.
  let haystackIndex = 0;
  for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
    const character = needle[needleIndex];
    while (haystackIndex < haystack.length && haystack[haystackIndex] !== character) {
      haystackIndex += 1;
    }
    if (haystackIndex === haystack.length) return null;
    haystackIndex += 1;
  }

  const indices: number[] = [];
  let position = 0;
  for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
    const character = needle[needleIndex];
    let found = -1;
    let wordStart = -1;
    for (let index = position; index < haystack.length; index += 1) {
      if (haystack[index] !== character) continue;
      if (found === -1) found = index;
      if (isWordStart(haystack, index, filenameStart)) {
        wordStart = index;
        break;
      }
      if (needleIndex > 0 && indices[needleIndex - 1] === index - 1) {
        found = index;
        break;
      }
    }
    const picked = wordStart !== -1 ? wordStart : found;
    if (picked === -1) return null;
    indices.push(picked);
    position = picked + 1;
  }

  let score = 0;
  for (let index = 0; index < indices.length; index += 1) {
    const matchIndex = indices[index];
    score += 16;
    if (matchIndex >= filenameStart) score += 8;
    if (isWordStart(haystack, matchIndex, filenameStart)) score += 24;
    if (index > 0 && indices[index - 1] === matchIndex - 1) score += 16;
    if (caseSensitive && haystack[matchIndex] === needle[index]) score += 4;
  }

  const span = indices[indices.length - 1] - indices[0] + 1;
  score -= (span - indices.length) * 2;
  if (indices[0] === filenameStart) score += 32;
  if (
    indices[0] === filenameStart &&
    indices.every((matchIndex, index) => matchIndex === filenameStart + index)
  ) {
    score += 64;
  }
  score -= Math.floor(haystack.length / 32);

  return { score, indices };
}

function isWordStart(value: string, index: number, filenameStart: number): boolean {
  if (index === 0 || index === filenameStart) return true;
  const previous = value.charCodeAt(index - 1);
  const current = value.charCodeAt(index);

  if (
    previous === 47 ||
    previous === 92 ||
    previous === 95 ||
    previous === 45 ||
    previous === 46 ||
    previous === 32
  ) {
    return true;
  }
  return previous >= 97 && previous <= 122 && current >= 65 && current <= 90;
}
