import { useMemo } from 'react';

function normalize(str: string) {
  return str
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

interface HighlightTextProps {
  text: string;
  query: string;
  /**
   * Pre-computed character indices to highlight (0-based, into `text`).
   * When provided, takes precedence over `query`-based substring matching.
   * Used by fuzzy-search results where matching characters aren't contiguous.
   */
  indices?: number[];
  className?: string;
}

export function HighlightText({ text, query, indices, className }: HighlightTextProps) {
  // Normalize text only when text changes — the expensive NFKC/NFKD passes
  // shouldn't re-run on every keystroke as the query changes.
  const normalizedText = useMemo(() => {
    const displayText = text.normalize('NFKC');
    return { displayText, lower: normalize(displayText) };
  }, [text]);

  const parts = useMemo(() => {
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

    const q = normalize(query);
    const { displayText, lower } = normalizedText;
    let idx = lower.indexOf(q);
    if (idx === -1) return [{ text: displayText, highlight: false }];

    const result: { text: string; highlight: boolean }[] = [];
    let pos = 0;
    while (idx !== -1) {
      if (idx > pos) {
        result.push({ text: displayText.slice(pos, idx), highlight: false });
      }
      result.push({ text: displayText.slice(idx, idx + q.length), highlight: true });
      pos = idx + q.length;
      idx = lower.indexOf(q, pos);
    }

    if (pos < displayText.length) {
      result.push({ text: displayText.slice(pos), highlight: false });
    }

    return result;
  }, [text, query, indices, normalizedText]);

  if (!query.trim()) {
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

export { normalize };
