import { ChevronRight, Bot } from 'lucide-react';
import { Suspense, lazy, useState, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';

import { remarkPlugins, baseMarkdownComponents } from '@/lib/markdown-components';
import { cn } from '@/lib/utils';

import { ToolCallCard } from '../ToolCallCard';

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

interface TaskCardProps {
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
  childToolCalls?: any[];
}

export const TaskCard = memo(function TaskCard({
  parsed,
  output: rawOutput,
  hideLabel,
  childToolCalls,
}: TaskCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const description = (parsed.description as string) ?? '';
  const hasChildren = childToolCalls && childToolCalls.length > 0;

  const output = useMemo(
    () => (rawOutput ? normalizeTaskOutput(rawOutput) : undefined),
    [rawOutput],
  );

  return (
    <div
      data-testid="task-card"
      className="max-w-full overflow-hidden rounded-lg border border-border text-sm"
    >
      <button
        type="button"
        data-testid="task-card-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/30"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {!hideLabel && <Bot className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
        {!hideLabel && (
          <span className="flex-shrink-0 font-mono font-medium text-foreground">
            {t('tools.subagent')}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {description}
        </span>
        {hasChildren && (
          <span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {childToolCalls.length} tools
          </span>
        )}
        {!output && (
          <span className="flex-shrink-0 text-[10px] italic text-muted-foreground/60">
            running…
          </span>
        )}
      </button>

      {expanded && (
        <div className="max-h-[60vh] overflow-y-auto border-t border-border/40">
          {/* Child tool calls from the subagent */}
          {hasChildren && (
            <div className="space-y-1 px-3 py-2">
              {childToolCalls.map((tc: any) => (
                <ToolCallCard key={tc.id} name={tc.name} input={tc.input} output={tc.output} />
              ))}
            </div>
          )}

          {/* Final text output rendered as markdown */}
          {output && (
            <div className="px-3 py-2">
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                {t('tools.output')}
              </div>
              <div className="prose prose-sm max-w-none rounded border border-border/40 bg-background/80 px-2.5 py-1.5">
                <Suspense
                  fallback={
                    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
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
            <div className="px-3 py-3 text-center text-xs italic text-muted-foreground/50">
              {t('tools.waitingForOutput')}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
