import { ChevronRight, Bot, Loader2 } from 'lucide-react';
import { Suspense, lazy, useState, useMemo, memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '@/components/ui/scroll-area';
import {
  remarkPlugins,
  baseMarkdownComponents,
  markdownProseClassName,
} from '@/lib/markdown-components';
import { groupConsecutiveToolCalls, type ToolItem } from '@/lib/render-items';
import { cn } from '@/lib/utils';

const LazyMarkdown = lazy(() =>
  import('react-markdown').then(({ default: ReactMarkdown }) => ({
    default: function TaskMarkdown({ content }: { content: string }) {
      return (
        <ReactMarkdown remarkPlugins={remarkPlugins} components={baseMarkdownComponents}>
          {content}
        </ReactMarkdown>
      );
    },
  })),
);

/**
 * Normalize Task tool output: legacy data stored output as a JSON-stringified
 * array of content blocks (e.g. [{"type":"text","text":"..."}]).
 * Extract and join the text blocks into a plain string.
 */
function normalizeTaskOutput(output: string): string {
  if (!output.startsWith('[')) return output;
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type === 'text') {
      return parsed
        .filter((b: any) => b.type === 'text' && b.text)
        .map((b: any) => b.text)
        .join('\n\n');
    }
  } catch {
    /* not JSON, use as-is */
  }
  return output;
}

export type RenderChildToolCall = (item: ToolItem, idx: number) => ReactNode;

interface TaskCardProps {
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
  childToolCalls?: any[];
  displayTime?: string | null;
  /**
   * Renderer for nested child tool calls. Injected by `ToolCallCard` so that
   * `TaskCard` doesn't have to import `ToolCallCard`/`ToolCallGroup`, which
   * would create a static cycle through the component tree.
   */
  renderChild?: RenderChildToolCall;
}

export const TaskCard = memo(function TaskCard({
  parsed,
  output: rawOutput,
  hideLabel,
  childToolCalls,
  displayTime,
  renderChild,
}: TaskCardProps) {
  const { t } = useTranslation();
  const isRunning = !rawOutput;
  const [expanded, setExpanded] = useState(isRunning);
  const description = (parsed.description as string) ?? '';
  const hasChildren = childToolCalls && childToolCalls.length > 0;

  const output = useMemo(
    () => (rawOutput ? normalizeTaskOutput(rawOutput) : undefined),
    [rawOutput],
  );

  const groupedChildren = useMemo(
    () => (hasChildren ? groupConsecutiveToolCalls(childToolCalls.map((tc: any) => ({ tc }))) : []),
    [hasChildren, childToolCalls],
  );

  return (
    <div
      data-testid="task-card"
      className="border-border max-w-full overflow-hidden rounded-lg border text-sm"
    >
      <button
        type="button"
        data-testid="task-card-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-accent/30 flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs"
      >
        <ChevronRight
          className={cn('icon-xs shrink-0 text-muted-foreground', expanded && 'rotate-90')}
        />
        {!hideLabel && <Bot className="icon-xs text-muted-foreground shrink-0" />}
        {!hideLabel && (
          <span className="text-foreground shrink-0 font-mono font-medium">
            {t('tools.subagent')}
          </span>
        )}
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {description}
        </span>
        {hasChildren && (
          <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]">
            {childToolCalls!.length} tool calls
          </span>
        )}
        {displayTime && (
          <span className="text-muted-foreground/50 ml-auto shrink-0 text-[10px] tabular-nums">
            {displayTime}
          </span>
        )}
        {!output && <Loader2 className="icon-xs text-muted-foreground shrink-0 animate-spin" />}
      </button>

      {expanded && (
        <ScrollArea
          className="border-border/40 border-t"
          viewportProps={{ className: 'max-h-[60vh]' }}
        >
          {/* Child tool calls from the subagent (grouped like main thread) */}
          {hasChildren && renderChild && (
            <div className="space-y-1 px-3 py-2">
              {groupedChildren.map((item, idx) => renderChild(item, idx))}
            </div>
          )}

          {/* Final text output rendered as markdown */}
          {output && (
            <div className="px-3 py-2">
              <div className="text-muted-foreground mb-1 text-xs font-semibold uppercase">
                {t('tools.output')}
              </div>
              <div
                className={cn(
                  markdownProseClassName,
                  'border-border/40 bg-background/80 rounded border px-2.5 py-1.5',
                )}
              >
                <Suspense
                  fallback={
                    <pre className="text-muted-foreground font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                      {output}
                    </pre>
                  }
                >
                  <LazyMarkdown content={output} />
                </Suspense>
              </div>
            </div>
          )}

          {/* Waiting state when no children and no output yet */}
          {!hasChildren && !output && (
            <div className="text-muted-foreground/50 px-3 py-3 text-center text-xs italic">
              {t('tools.waitingForOutput')}
            </div>
          )}
        </ScrollArea>
      )}
    </div>
  );
});
