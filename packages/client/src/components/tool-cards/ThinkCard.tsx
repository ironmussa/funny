import type { JsonObject } from '@funny/shared/json';
import { Brain, ChevronRight } from 'lucide-react';
import { Suspense, lazy, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { remarkPlugins, markdownProseClassName } from '@/lib/markdown-components';
import { cn } from '@/lib/utils';

import { ToolContentArea } from './MobileContentPreview';
// Security ME-9: rehypeSanitize is mandatory on every ReactMarkdown sink
// (see MessageContent.tsx). Lazy-loaded alongside react-markdown.
const LazyMarkdown = lazy(() =>
  Promise.all([import('react-markdown'), import('rehype-sanitize')]).then(
    ([{ default: ReactMarkdown }, { default: rehypeSanitize }]) => ({
      default: function ThinkMarkdown({ content }: { content: string }) {
        return (
          <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={[rehypeSanitize]}>
            {content}
          </ReactMarkdown>
        );
      },
    }),
  ),
);

function getThinkingPreview(content: string): string {
  return content
    .replace(/^[\s>#*-]+/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ThinkCard({
  parsed,
  output,
  hideLabel,
  displayTime,
}: {
  parsed: JsonObject;
  output?: string;
  hideLabel?: boolean;
  displayTime?: string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // SAFETY: Think inputs carry their text in content or description, both strings.
  const content = output || (parsed.content as string) || (parsed.description as string) || '';

  if (!content) return null;

  const preview = getThinkingPreview(content);

  return (
    <div
      data-expanded={expanded}
      className="tool-card-frame max-w-full overflow-hidden rounded-lg text-sm"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="hover:bg-accent/30 flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs"
      >
        <ChevronRight
          className={cn('icon-xs text-muted-foreground shrink-0', expanded && 'rotate-90')}
        />
        {!hideLabel && <Brain className="icon-xs text-muted-foreground shrink-0" />}
        {!hideLabel && (
          <span className="text-foreground shrink-0 font-mono font-medium">
            {t('tools.thinking')}
          </span>
        )}
        {!expanded && preview && (
          <span
            data-testid="think-card-preview"
            className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
          >
            {preview}
          </span>
        )}
        {displayTime && (
          <span className="text-muted-foreground/50 text-2xs ml-auto shrink-0 tabular-nums">
            {displayTime}
          </span>
        )}
      </button>
      {expanded && (
        <ToolContentArea viewportProps={{ className: 'max-h-[50vh] scroll-fade-none' }}>
          <div className="px-4 py-3" data-testid="think-card-content">
            <div className={markdownProseClassName}>
              <Suspense
                fallback={
                  <pre className="text-muted-foreground font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                    {content}
                  </pre>
                }
              >
                <LazyMarkdown content={content} />
              </Suspense>
            </div>
          </div>
        </ToolContentArea>
      )}
    </div>
  );
}
