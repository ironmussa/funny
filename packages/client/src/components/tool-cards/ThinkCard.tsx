import { Brain } from 'lucide-react';
import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '@/components/ui/scroll-area';
import { remarkPlugins, markdownProseClassName } from '@/lib/markdown-components';
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

export function ThinkCard({
  parsed,
  output,
  hideLabel,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
  displayTime?: string | null;
}) {
  const { t } = useTranslation();
  const content = output || (parsed.content as string) || (parsed.description as string) || '';

  if (!content) return null;

  return (
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-sm">
      <div className="flex w-full items-center gap-2 overflow-hidden px-3 py-1.5 text-left text-xs">
        {!hideLabel && <Brain className="icon-xs text-muted-foreground shrink-0" />}
        {!hideLabel && (
          <span className="text-foreground shrink-0 font-mono font-medium">
            {t('tools.thinking')}
          </span>
        )}
        {displayTime && (
          <span className="text-muted-foreground/50 ml-auto shrink-0 text-[10px] tabular-nums">
            {displayTime}
          </span>
        )}
      </div>
      <ScrollArea
        className="border-border/40 border-t"
        viewportProps={{ className: 'max-h-[50vh] scroll-fade-none' }}
      >
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
      </ScrollArea>
    </div>
  );
}
