import { useEffect, useState } from 'react';

import { ensureHighlight, highlightCode } from '@/hooks/use-highlight';
import { cn } from '@/lib/utils';

/**
 * A code block highlighted in `language` once its grammar has loaded; plain
 * text before that, or when there is no language.
 */
export function HighlightedCode({
  code,
  language,
  className,
}: {
  code: string;
  language: string | null;
  className?: string;
}) {
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language: string;
    html: string;
  } | null>(null);

  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    ensureHighlight(code, language).then((ok) => {
      if (cancelled || !ok) return;
      setHighlighted({ code, language, html: highlightCode(code, language) });
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const pre = 'm-0 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap';
  if (language && highlighted?.code === code && highlighted.language === language) {
    return (
      <pre className={cn('code-viewer hljs text-foreground', pre, className)}>
        <code
          className={`hljs language-${language}`}
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      </pre>
    );
  }
  return <pre className={cn('text-foreground/80', pre, className)}>{code}</pre>;
}
