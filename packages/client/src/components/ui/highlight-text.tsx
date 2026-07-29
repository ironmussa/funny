import { findTextSearchMatches, normalizeSearchText } from '@funny/shared/lib/text-search';
import { useMemo } from 'react';

// Kept as a compatibility export while consumers move to the shared matcher.
export const normalize = normalizeSearchText;

interface HighlightTextProps {
  text: string;
  query?: string;
  /**
   * Pre-computed character indices to highlight (0-based, into `text`).
   * When provided, takes precedence over `query`-based substring matching.
   * Used by fuzzy-search results where matching characters aren't contiguous.
   */
  indices?: number[];
  /**
   * Pre-computed [start, end) ranges to highlight (0-based, into `text`).
   * When provided, takes precedence over `query` and `indices`.
   * Used by backends (e.g. ripgrep) that emit explicit match offsets.
   */
  ranges?: Array<{ start: number; end: number }>;
  className?: string;
}

export function HighlightText({
  text,
  query = '',
  indices,
  ranges,
  className,
}: HighlightTextProps) {
  const parts = useMemo(() => {
    // Range-based highlighting (from ripgrep / explicit offsets)
    if (ranges && ranges.length > 0) {
      const out: { text: string; highlight: boolean }[] = [];
      let cursor = 0;
      for (const r of ranges) {
        const start = Math.max(0, Math.min(r.start, text.length));
        const end = Math.max(start, Math.min(r.end, text.length));
        if (start > cursor) out.push({ text: text.slice(cursor, start), highlight: false });
        if (end > start) out.push({ text: text.slice(start, end), highlight: true });
        cursor = end;
      }
      if (cursor < text.length) out.push({ text: text.slice(cursor), highlight: false });
      return out;
    }

    if (!query.trim()) return [{ text, highlight: false }];

    // Index-based highlighting (from fuzzy scorer)
    if (indices && indices.length > 0) {
      const set = new Set(indices.filter((i) => i >= 0 && i < text.length));
      if (set.size === 0) return [{ text, highlight: false }];
      const out: { text: string; highlight: boolean }[] = [];
      let i = 0;
      while (i < text.length) {
        const isHi = set.has(i);
        let j = i + 1;
        while (j < text.length && set.has(j) === isHi) j++;
        out.push({ text: text.slice(i, j), highlight: isHi });
        i = j;
      }
      return out;
    }

    const matches = findTextSearchMatches(text, query);
    if (matches.length === 0) return [{ text, highlight: false }];

    const result: { text: string; highlight: boolean }[] = [];
    let pos = 0;
    for (const match of matches) {
      if (match.start > pos) {
        result.push({ text: text.slice(pos, match.start), highlight: false });
      }
      result.push({ text: text.slice(match.start, match.end), highlight: true });
      pos = match.end;
    }

    if (pos < text.length) {
      result.push({ text: text.slice(pos), highlight: false });
    }

    return result;
  }, [text, query, indices, ranges]);

  if (!query.trim() && !(ranges && ranges.length > 0) && !(indices && indices.length > 0)) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.highlight ? (
          <mark
            key={`hl-${i}`}
            style={{ backgroundColor: '#FFE500', color: 'black' }}
            className="rounded-sm px-px font-semibold"
          >
            {part.text}
          </mark>
        ) : (
          <span key={`hl-${i}`}>{part.text}</span>
        ),
      )}
    </span>
  );
}
