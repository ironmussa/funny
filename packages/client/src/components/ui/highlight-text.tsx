import { useMemo } from 'react';

function normalize(str: string) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

interface HighlightTextProps {
  text: string;
  query: string;
  className?: string;
}

export function HighlightText({ text, query, className }: HighlightTextProps) {
  const parts = useMemo(() => {
    if (!query.trim()) return [{ text, highlight: false }];

    const q = normalize(query);
    const result: { text: string; highlight: boolean }[] = [];
    const normalizedText = normalize(text);
    let pos = 0;
    let idx = normalizedText.indexOf(q, pos);

    while (idx !== -1) {
      if (idx > pos) {
        result.push({ text: text.slice(pos, idx), highlight: false });
      }
      result.push({ text: text.slice(idx, idx + q.length), highlight: true });
      pos = idx + q.length;
      idx = normalizedText.indexOf(q, pos);
    }

    if (pos < text.length) {
      result.push({ text: text.slice(pos), highlight: false });
    }

    return result;
  }, [text, query]);

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
