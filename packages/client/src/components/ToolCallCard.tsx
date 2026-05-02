import { ChevronRight, Wrench, ListTodo, Check } from 'lucide-react';
import { useState, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';

import { MessageContent } from './thread/MessageContent';
import { AskQuestionCard } from './tool-cards/AskQuestionCard';
import { BashCard } from './tool-cards/BashCard';
import { EditFileCard } from './tool-cards/EditFileCard';
import { ExitPlanModeCard } from './tool-cards/ExitPlanModeCard';
import { PlanCard } from './tool-cards/PlanCard';
import { ReadFileCard } from './tool-cards/ReadFileCard';
import { TaskCard } from './tool-cards/TaskCard';
import { ThinkCard } from './tool-cards/ThinkCard';
import { TodoList } from './tool-cards/TodoList';
import {
  formatInput,
  getTodos,
  getFilePath,
  getSummary,
  getToolLabel,
  toEditorUri,
  openFileInEditor,
  getEditorLabel,
  useCurrentProjectPath,
  makeRelativePath,
} from './tool-cards/utils';
import { WriteFileCard } from './tool-cards/WriteFileCard';

interface ToolCallCardProps {
  name: string;
  input: string | Record<string, unknown>;
  output?: string;
  onRespond?: (answer: string) => void;
  /** When true, hides the tool label (used inside ToolCallGroup to avoid redundancy) */
  hideLabel?: boolean;
  /** Plan text from the parent assistant message (for ExitPlanMode) */
  planText?: string;
  /** Nested tool calls from a subagent (Task tool) */
  childToolCalls?: any[];
  /** ISO timestamp of when this tool call was executed */
  timestamp?: string;
}

export const ToolCallCard = memo(
  function ToolCallCard({
    name,
    input,
    output,
    onRespond,
    hideLabel,
    planText,
    childToolCalls,
    timestamp,
  }: ToolCallCardProps) {
    const { t } = useTranslation();
    const isTodo = name === 'TodoWrite';
    const [expanded, setExpanded] = useState(!!onRespond || isTodo);
    const parsed = useMemo(() => formatInput(input), [input]);
    const label = getToolLabel(name, t);
    const summary = getSummary(name, parsed, t);

    const isPlan = typeof parsed.plan === 'string' && parsed.plan.length > 0;
    const todos = isTodo ? getTodos(parsed) : null;
    const filePath = getFilePath(name, parsed);
    const defaultEditor = useSettingsStore((s) => s.defaultEditor);
    const projectPath = useCurrentProjectPath();
    const displayPath = filePath ? makeRelativePath(filePath, projectPath) : null;
    const displayTime = useMemo(() => (timestamp ? timeAgo(timestamp, t) : null), [timestamp, t]);

    // Security M6: `createAnsiConverter` enforces escapeXML regardless of caller.
    const ansiConverter = useMemo(
      () => createAnsiConverter({ fg: '#a1a1aa', bg: 'transparent', newline: false }),
      [],
    );
    const htmlOutput = useMemo(
      () => (output ? ansiConverter.toHtml(output) : null),
      [ansiConverter, output],
    );

    // Truncated output preview for collapsed cards (strip ANSI for plain-text preview)
    const outputPreview = useMemo(() => {
      if (!output || expanded) return null;
      // Strip ANSI escape codes for the preview text
      // eslint-disable-next-line no-control-regex
      const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
      const firstLine = clean
        .split('\n')
        .find((l) => l.trim())
        ?.trim();
      if (!firstLine) return null;
      return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
    }, [output, expanded]);

    // Specialized cards
    // ExitPlanMode: prefer planText (which includes content from a Write to plan.md
    // if one exists), then fall back to parsed.plan from the tool input
    if (name === 'ExitPlanMode')
      return (
        <ExitPlanModeCard
          plan={planText || (typeof parsed.plan === 'string' ? parsed.plan : undefined)}
          onRespond={output ? undefined : onRespond}
          output={output}
          displayTime={displayTime}
        />
      );
    if (isPlan)
      return (
        <PlanCard parsed={parsed} output={output} hideLabel={hideLabel} displayTime={displayTime} />
      );
    if (name === 'Bash')
      return (
        <BashCard parsed={parsed} output={output} hideLabel={hideLabel} displayTime={displayTime} />
      );
    if (name === 'Read')
      return (
        <ReadFileCard
          parsed={parsed}
          output={output}
          hideLabel={hideLabel}
          displayTime={displayTime}
        />
      );
    if (name === 'Write')
      return <WriteFileCard parsed={parsed} hideLabel={hideLabel} displayTime={displayTime} />;
    if (name === 'Edit')
      return <EditFileCard parsed={parsed} hideLabel={hideLabel} displayTime={displayTime} />;
    if (name === 'AskUserQuestion')
      return (
        <AskQuestionCard
          parsed={parsed}
          onRespond={output ? undefined : onRespond}
          output={output}
          hideLabel={hideLabel}
          displayTime={displayTime}
        />
      );
    if (name === 'Task' || name === 'Agent')
      return (
        <TaskCard
          parsed={parsed}
          output={output}
          hideLabel={hideLabel}
          childToolCalls={childToolCalls}
          displayTime={displayTime}
        />
      );
    if (name === 'Think')
      return (
        <ThinkCard
          parsed={parsed}
          output={output}
          hideLabel={hideLabel}
          displayTime={displayTime}
        />
      );

    return (
      <div className="max-w-full overflow-hidden rounded-lg border border-border text-sm">
        <button
          type="button"
          aria-expanded={expanded}
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
            {!hideLabel &&
              (isTodo ? (
                <ListTodo className="icon-xs flex-shrink-0 text-muted-foreground" />
              ) : (
                <Wrench className="icon-xs flex-shrink-0 text-muted-foreground" />
              ))}
            {!hideLabel && (
              <span className="flex-shrink-0 font-mono font-medium text-foreground">{label}</span>
            )}
            {summary &&
              (filePath ? (
                (() => {
                  const editorUri = toEditorUri(filePath, defaultEditor);
                  const editorTitle = t('tools.openInEditor', {
                    editor: getEditorLabel(defaultEditor),
                    path: filePath,
                  });
                  return (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {editorUri ? (
                          <a
                            href={editorUri}
                            onClick={(e) => e.stopPropagation()}
                            className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
                          >
                            {displayPath}
                          </a>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openFileInEditor(filePath, defaultEditor);
                            }}
                            className="min-w-0 truncate text-left font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
                          >
                            {displayPath}
                          </button>
                        )}
                      </TooltipTrigger>
                      <TooltipContent>{editorTitle}</TooltipContent>
                    </Tooltip>
                  );
                })()
              ) : name === 'WebFetch' && summary ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href={summary}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
                      data-testid="tool-webfetch-url"
                    >
                      {summary}
                    </a>
                  </TooltipTrigger>
                  <TooltipContent>{summary}</TooltipContent>
                </Tooltip>
              ) : (
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {summary}
                </span>
              ))}
            {displayTime && (
              <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
                {displayTime}
              </span>
            )}
          </div>
          {!expanded && outputPreview && (
            <div className="-mt-0.5 px-3 pb-1.5">
              <p className="truncate font-mono text-xs leading-tight text-muted-foreground/70">
                → {outputPreview}
              </p>
            </div>
          )}
        </button>
        {expanded && (
          <ScrollArea className="max-h-[50vh] border-t border-border/40">
            {isTodo && todos ? (
              <div className="px-3">
                <TodoList todos={todos} />
              </div>
            ) : (
              <div className="px-3">
                <div className="mt-1.5 space-y-1.5">
                  {Object.entries(parsed).map(([key, value]) => (
                    <div key={key}>
                      <div className="mb-0.5 text-xs font-semibold uppercase text-muted-foreground">
                        {key}
                      </div>
                      <div className="overflow-x-auto rounded border border-border/40 bg-background/80 px-2.5 py-1.5">
                        {name === 'WebFetch' && key === 'url' && typeof value === 'string' ? (
                          <a
                            href={value}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/80 hover:text-primary hover:underline"
                            data-testid="tool-webfetch-url-detail"
                          >
                            {value}
                          </a>
                        ) : (
                          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/80">
                            {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {output && (
                  <div className="mt-2">
                    <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                      {t('tools.output')}
                    </div>
                    {name === 'WebFetch' || name === 'WebSearch' ? (
                      <div className="rounded border border-border/40 bg-background/80 px-2.5 py-1.5 text-sm text-foreground/80">
                        <MessageContent content={output} />
                      </div>
                    ) : (
                      <div className="rounded border border-border/40 bg-background/80 px-2.5 py-1.5">
                        <pre
                          className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground"
                          dangerouslySetInnerHTML={{ __html: htmlOutput! }}
                        />
                      </div>
                    )}
                  </div>
                )}
                {onRespond && !output && (
                  <div className="flex justify-end pt-2">
                    <button
                      onClick={() => onRespond('Accepted')}
                      className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      <Check className="icon-xs" />
                      {t('tools.respond')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </ScrollArea>
        )}
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.name === next.name &&
      prev.input === next.input &&
      prev.output === next.output &&
      prev.hideLabel === next.hideLabel &&
      !!prev.onRespond === !!next.onRespond &&
      prev.planText === next.planText &&
      prev.childToolCalls === next.childToolCalls &&
      prev.timestamp === next.timestamp
    );
  },
);
