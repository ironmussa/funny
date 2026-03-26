import { Brain, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

export function ThinkCard({
  parsed,
  output,
  hideLabel,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const content = output || (parsed.content as string) || (parsed.description as string) || '';

  // Show a short preview when collapsed
  const preview =
    content
      .split('\n')
      .find((l) => l.trim())
      ?.trim() || '';
  const truncatedPreview = preview.length > 100 ? preview.slice(0, 100) + '…' : preview;

  if (!content) return null;

  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        data-testid="think-card-toggle"
        className="w-full cursor-pointer rounded-md text-left transition-colors hover:bg-accent/30"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex w-full items-center gap-2 overflow-hidden px-3 py-1.5 text-left text-xs">
          <ChevronRight
            className={cn(
              'icon-xs flex-shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          {!hideLabel && <Brain className="icon-xs flex-shrink-0 text-muted-foreground" />}
          {!hideLabel && (
            <span className="flex-shrink-0 font-mono font-medium text-foreground">
              {t('tools.thinking')}
            </span>
          )}
          {!expanded && truncatedPreview && (
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {truncatedPreview}
            </span>
          )}
        </div>
      </button>
      {expanded && (
        <div className="max-h-[50vh] overflow-y-auto border-t border-border/40 px-4 py-3">
          <div className="prose prose-xs prose-invert prose-p:text-xs prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:my-0.5 prose-li:text-sm prose-li:text-muted-foreground prose-code:text-xs prose-code:bg-background/80 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground prose-pre:bg-background/80 prose-pre:rounded prose-pre:p-2 prose-strong:text-foreground max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
