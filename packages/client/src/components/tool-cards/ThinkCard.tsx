import { Brain } from 'lucide-react';
import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '@/components/ui/scroll-area';
import { remarkPlugins } from '@/lib/markdown-components';
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
    <div className="max-w-full overflow-hidden rounded-lg border border-border text-sm">
      <div className="flex w-full items-center gap-2 overflow-hidden px-3 py-1.5 text-left text-xs">
        {!hideLabel && <Brain className="icon-xs flex-shrink-0 text-muted-foreground" />}
        {!hideLabel && (
          <span className="flex-shrink-0 font-mono font-medium text-foreground">
            {t('tools.thinking')}
          </span>
        )}
        {displayTime && (
          <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
            {displayTime}
          </span>
        )}
      </div>
      <ScrollArea
        className="border-t border-border/40"
        viewportProps={{ className: 'max-h-[50vh]' }}
      >
        <div className="px-4 py-3" data-testid="think-card-content">
          <div className="prose prose-xs prose-invert prose-p:text-xs prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:my-0.5 prose-li:text-sm prose-li:text-muted-foreground prose-code:text-xs prose-code:bg-background/80 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground prose-pre:bg-background/80 prose-pre:rounded prose-pre:p-2 prose-strong:text-foreground max-w-none">
            <Suspense
              fallback={
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
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
