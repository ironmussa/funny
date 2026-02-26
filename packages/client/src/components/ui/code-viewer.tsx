import { useState, useEffect } from 'react';

import { useShiki } from '@/hooks/use-shiki';
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
  const { highlight, ready } = useShiki();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !code) return;
    let cancelled = false;
    highlight(code, language).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, ready, highlight]);

  return (
    <div className={cn('overflow-x-auto overflow-y-auto', className)} style={{ maxHeight }}>
      {html ? (
        <div
          className="code-viewer font-mono text-xs leading-relaxed"
          style={{ counterReset: `line ${startLine - 1}` }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="whitespace-pre px-10 py-2 font-mono text-xs leading-relaxed text-foreground/80">
          {code}
        </pre>
      )}
    </div>
  );
}
