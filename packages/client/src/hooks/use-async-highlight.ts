import { useEffect, useState } from 'react';

import { ensureHighlight, highlightCode } from '@/hooks/use-highlight';

/**
 * `code` highlighted as `lang`, once its grammar is loaded. Losing the code
 * (null) drops the highlight at once; changed code keeps the old highlight
 * until the new one is ready.
 */
export function useAsyncHighlight(code: string | null | undefined, lang: string): string | null {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const hasCode = code != null;
  const [hadCode, setHadCode] = useState(hasCode);
  if (hadCode !== hasCode) {
    setHadCode(hasCode);
    if (!hasCode) setHighlighted(null);
  }

  useEffect(() => {
    if (code == null) return;
    let cancelled = false;
    void ensureHighlight(code, lang).then(() => {
      if (!cancelled) setHighlighted(highlightCode(code, lang));
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return highlighted;
}
