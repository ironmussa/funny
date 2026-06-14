import { highlightLine } from '@/hooks/use-highlight';
import { escapeRegExp } from '@/lib/diff-math';
import { metric } from '@/lib/telemetry';

export { countTextMatches, escapeRegExp } from '@/lib/diff-math';

/* ── Highlight cache ── */

export const highlightCache = new Map<string, string>();

// Module-local counters flushed periodically to keep hot path allocation-free.
// metric() is gated on telemetry-enabled, so the flush itself is near-free when disabled.
let hCacheHits = 0;
let hCacheMisses = 0;
let hMissTotalMs = 0;
let hEvictions = 0;
let hCalls = 0;
const HIGHLIGHT_FLUSH_EVERY = 2000;

function flushHighlightMetrics(): void {
  if (hCacheHits) metric('diff.highlight.cache.hits', hCacheHits, { type: 'sum' });
  if (hCacheMisses) metric('diff.highlight.cache.misses', hCacheMisses, { type: 'sum' });
  if (hMissTotalMs)
    metric('diff.highlight.miss.total_ms', Math.round(hMissTotalMs), { type: 'sum' });
  if (hEvictions) metric('diff.highlight.cache.evictions', hEvictions, { type: 'sum' });
  metric('diff.highlight.cache.size', highlightCache.size, { type: 'gauge' });
  hCacheHits = 0;
  hCacheMisses = 0;
  hMissTotalMs = 0;
  hEvictions = 0;
  hCalls = 0;
}

export function getCachedHighlight(text: string, lang: string): string {
  const key = `${lang}:${text}`;
  let cached = highlightCache.get(key);
  if (cached === undefined) {
    const t0 = performance.now();
    cached = highlightLine(text, lang);
    hMissTotalMs += performance.now() - t0;
    highlightCache.set(key, cached);
    hCacheMisses++;
    if (highlightCache.size > 20_000) {
      const iter = highlightCache.keys();
      for (let i = 0; i < 5_000; i++) {
        const k = iter.next();
        if (k.done) break;
        highlightCache.delete(k.value);
      }
      hEvictions++;
    }
  } else {
    hCacheHits++;
  }
  if (++hCalls >= HIGHLIGHT_FLUSH_EVERY) flushHighlightMetrics();
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

/**
 * Wrap intra-line word-diff ranges in `<span class={className}>` over already
 * syntax-highlighted HTML. Like {@link injectSearchMarks}, it only touches text
 * nodes (never tags). Char offsets are measured against the *rendered* text, so
 * HTML entities (`&lt;`, `&amp;`, …) count as a single raw character — matching
 * the offsets produced by the word-diff over the unescaped line text.
 */
export function injectWordDiffMarks(
  html: string,
  segments: ReadonlyArray<readonly [number, number]>,
  className: string,
): string {
  if (segments.length === 0) return html;
  let rawPos = 0;
  let segIdx = 0;

  return html.replace(
    /(<[^>]*>)|([^<]+)/g,
    (_, tag: string | undefined, text: string | undefined) => {
      if (tag) return tag;
      const t = text ?? '';
      let out = '';
      let open = false;
      let k = 0;
      while (k < t.length) {
        // One rendered character — an HTML entity (&...;) is a single raw char.
        let tok: string;
        if (t[k] === '&') {
          const semi = t.indexOf(';', k);
          if (semi !== -1 && semi - k <= 10) {
            tok = t.slice(k, semi + 1);
            k = semi + 1;
          } else {
            tok = t[k];
            k++;
          }
        } else {
          tok = t[k];
          k++;
        }
        while (segIdx < segments.length && rawPos >= segments[segIdx][1]) segIdx++;
        const inSeg =
          segIdx < segments.length && rawPos >= segments[segIdx][0] && rawPos < segments[segIdx][1];
        if (inSeg && !open) {
          out += `<span class="${className}">`;
          open = true;
        } else if (!inSeg && open) {
          out += '</span>';
          open = false;
        }
        out += tok;
        rawPos++;
      }
      if (open) out += '</span>';
      return out;
    },
  );
}

/**
 * Syntax highlight + optional word-diff segment shading + optional search marks,
 * in that nesting order. Shared by the unified/split/three-pane row components.
 */
export function getDiffHighlight(
  text: string,
  lang: string,
  segments?: ReadonlyArray<readonly [number, number]>,
  segmentClass?: string,
  query?: string,
  globalOffset = 0,
  currentIdx = -1,
  caseSensitive = false,
): string {
  let html = getCachedHighlight(text, lang);
  if (segments && segments.length > 0 && segmentClass) {
    html = injectWordDiffMarks(html, segments, segmentClass);
  }
  if (query) html = injectSearchMarks(html, query, globalOffset, currentIdx, caseSensitive);
  return html;
}
