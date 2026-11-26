import { useMemo } from 'react';

import { createAnsiConverter } from '@/lib/ansi-to-html';

import { HighlightedCode } from './HighlightedCode';

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * One tool input value: JSON highlighted for objects, `language` highlighted
 * for code strings, and ANSI colors for any other string.
 */
export function ToolValue({ value, language }: { value: unknown; language?: string | null }) {
  const isJson = !isString(value);
  const text = useMemo(() => {
    if (isString(value)) return value;
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }, [value]);
  const codeLanguage = isJson ? 'json' : (language ?? null);
  const ansiConverter = useMemo(
    () => createAnsiConverter({ fg: '#a1a1aa', bg: 'transparent', newline: false }),
    [],
  );
  const html = useMemo(
    () => (codeLanguage ? null : ansiConverter.toHtml(text)),
    [ansiConverter, codeLanguage, text],
  );

  if (codeLanguage) return <HighlightedCode code={text} language={codeLanguage} />;

  return (
    <pre
      className="text-foreground/80 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
      dangerouslySetInnerHTML={{ __html: html! }}
    />
  );
}
