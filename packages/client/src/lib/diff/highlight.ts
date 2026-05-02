import { highlightLine } from '@/hooks/use-highlight';
import { escapeRegExp } from '@/lib/diff-math';

export { countTextMatches, escapeRegExp } from '@/lib/diff-math';

/* ── Highlight cache ── */

export const highlightCache = new Map<string, string>();

export function getCachedHighlight(text: string, lang: string): string {
  const key = `${lang}:${text}`;
  let cached = highlightCache.get(key);
  if (cached === undefined) {
    cached = highlightLine(text, lang);
    highlightCache.set(key, cached);
    if (highlightCache.size > 20_000) {
      const iter = highlightCache.keys();
      for (let i = 0; i < 5_000; i++) {
        const k = iter.next();
        if (k.done) break;
        highlightCache.delete(k.value);
      }
    }
  }
  return cached;
}

/**
 * Inject `<mark>` tags into syntax-highlighted HTML for search matches.
 * Only replaces inside text nodes (not HTML tag attributes).
 * `globalOffset` is the number of matches before this text span.
 * `currentIdx` is the global index of the "current" match (-1 for none).
 */
export function injectSearchMarks(
  html: string,
  query: string,
  globalOffset: number,
  currentIdx: number,
  caseSensitive = false,
): string {
  if (!query) return html;
  const escaped = escapeRegExp(query);
  const regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
  let counter = globalOffset;

  return html.replace(
    /(<[^>]*>)|([^<]+)/g,
    (_, tag: string | undefined, text: string | undefined) => {
      if (tag) return tag;
      return (text ?? '').replace(regex, (m: string) => {
        const isCurrent = counter === currentIdx;
        counter++;
        return `<mark class="diff-search-hl${isCurrent ? ' diff-search-current' : ''}">${m}</mark>`;
      });
    },
  );
}

export function getSearchHighlight(
  text: string,
  lang: string,
  query?: string,
  globalOffset = 0,
  currentIdx = -1,
  caseSensitive = false,
): string {
  const html = getCachedHighlight(text, lang);
  if (!query) return html;
  return injectSearchMarks(html, query, globalOffset, currentIdx, caseSensitive);
}
