import { useState, useEffect } from 'react';

import { ensureHighlight, highlightCode } from '@/hooks/use-highlight';
import { cn } from '@/lib/utils';

interface CodeViewerProps {
  code: string;
  language: string;
  startLine?: number;
  maxHeight?: string;
  className?: string;
  /** 8px above and below the code, inside the scroll box. */
  padded?: boolean;
}

export function CodeViewer({
  code,
  language,
  startLine = 1,
  maxHeight = '320px',
  className,
  padded = false,
}: CodeViewerProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    ensureHighlight(code, language).then(() => {
      if (!cancelled) {
        setHtml(highlightCode(code, language));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return (
    <div
      className={cn('overflow-x-auto overflow-y-auto', padded && 'py-2', className)}
      style={{ maxHeight }}
    >
      {html ? (
        <div
          className="hljs code-viewer px-3 font-mono text-xs leading-relaxed whitespace-pre"
          style={{ counterReset: `line ${startLine - 1}` }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="text-foreground/80 px-10 py-2 font-mono text-xs leading-relaxed whitespace-pre">
          {code}
        </pre>
      )}
    </div>
  );
}
