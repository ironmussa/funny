import { useState, useEffect } from 'react';

import { ensureLanguage, highlightCode } from '@/hooks/use-highlight';
import { cn } from '@/lib/utils';

interface CodeViewerProps {
  code: string;
  language: string;
  startLine?: number;
  maxHeight?: string;
  className?: string;
}

export function CodeViewer({
  code,
  language,
  startLine = 1,
  maxHeight = '320px',
  className,
}: CodeViewerProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    ensureLanguage(language).then(() => {
      if (!cancelled) {
        setHtml(highlightCode(code, language));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return (
    <div className={cn('overflow-x-auto overflow-y-auto', className)} style={{ maxHeight }}>
      {html ? (
        <div
          className="hljs code-viewer font-mono text-xs leading-relaxed"
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
