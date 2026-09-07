import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { buildHtmlPreview } from '@/lib/html-preview';

export function HtmlPreview({ content, filePath }: { content: string; filePath: string }) {
  const { t } = useTranslation();
  const srcDoc = useMemo(() => buildHtmlPreview(content, filePath), [content, filePath]);

  return (
    <iframe
      title={t('tools.preview', 'Preview') + `: ${filePath}`}
      srcDoc={srcDoc}
      // Local assets require SameSite session cookies. Keep the document's origin
      // while still blocking scripts, forms, popups and top-level navigation.
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
      data-testid="html-preview"
    />
  );
}
