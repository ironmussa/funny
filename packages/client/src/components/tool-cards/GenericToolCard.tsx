import { Check, ChevronRight, ListTodo, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MessageContent } from '@/components/thread/MessageContent';
import { TodoList } from '@/components/tool-cards/TodoList';
import { getEditorLabel, openFileInEditor, toEditorUri } from '@/components/tool-cards/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { cn } from '@/lib/utils';
import { useSettingsStore, type Editor } from '@/stores/settings-store';

interface Props {
  name: string;
  parsed: Record<string, any>;
  output?: string;
  onRespond?: (answer: string) => void;
  hideLabel?: boolean;
  displayTime: string | null;
  label: string;
  summary: string | null | undefined;
  filePath: string | null;
  displayPath: string | null;
  isTodo: boolean;
  todos: any[] | null;
}

/**
 * The fallback "generic" tool card used when no specialized renderer matches.
 * Owns the expand/collapse state, the ANSI-rendered output panel, and the
 * editor-link tooltip in the header. Extracted from ToolCallCard so the
 * parent doesn't import the ScrollArea/Tooltip/MessageContent/ansi-to-html/
 * settings-store cluster.
 */
export function GenericToolCard({
  name,
  parsed,
  output,
  onRespond,
  hideLabel,
  displayTime,
  label,
  summary,
  filePath,
  displayPath,
  isTodo,
  todos,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(!!onRespond || isTodo);
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);

  const ansiConverter = useMemo(
    () => createAnsiConverter({ fg: '#a1a1aa', bg: 'transparent', newline: false }),
    [],
  );
  const htmlOutput = useMemo(
    () => (output ? ansiConverter.toHtml(output) : null),
    [ansiConverter, output],
  );

  const outputPreview = useMemo(() => {
    if (!output || expanded) return null;
    // eslint-disable-next-line no-control-regex
    const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
    const firstLine = clean
      .split('\n')
      .find((l) => l.trim())
      ?.trim();
    if (!firstLine) return null;
    return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
  }, [output, expanded]);

  return (
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        className="hover:bg-accent/30 w-full cursor-pointer rounded-md text-left transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex w-full items-center gap-2 overflow-hidden px-3 py-1.5 text-left text-xs">
          <ChevronRight
            className={cn(
              'icon-xs shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          {!hideLabel &&
            (isTodo ? (
              <ListTodo className="icon-xs text-muted-foreground shrink-0" />
            ) : (
              <Wrench className="icon-xs text-muted-foreground shrink-0" />
            ))}
          {!hideLabel && (
            <span className="text-foreground shrink-0 font-mono font-medium">{label}</span>
          )}
          {summary && filePath && (
            <FileLink filePath={filePath} displayPath={displayPath} defaultEditor={defaultEditor} />
          )}
          {summary && !filePath && name === 'WebFetch' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={summary}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-primary min-w-0 truncate font-mono text-xs hover:underline"
                  data-testid="tool-webfetch-url"
                >
                  {summary}
                </a>
              </TooltipTrigger>
              <TooltipContent>{summary}</TooltipContent>
            </Tooltip>
          )}
          {summary && !filePath && name !== 'WebFetch' && (
            <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
              {summary}
            </span>
          )}
          {displayTime && (
            <span className="text-muted-foreground/50 ml-auto shrink-0 text-[10px] tabular-nums">
              {displayTime}
            </span>
          )}
        </div>
        {!expanded && outputPreview && (
          <div className="-mt-0.5 px-3 pb-1.5">
            <p className="text-muted-foreground/70 truncate font-mono text-xs leading-tight">
              → {outputPreview}
            </p>
          </div>
        )}
      </button>
      {expanded && (
        <ScrollArea
          className="border-border/40 border-t"
          viewportProps={{ className: 'max-h-[50vh]' }}
        >
          {isTodo && todos ? (
            <div className="px-3 pb-2">
              <TodoList todos={todos} />
            </div>
          ) : (
            <div className="px-3 pb-2">
              <div className="mt-1.5 space-y-1.5">
                {Object.entries(parsed).map(([key, value]) => (
                  <div key={key}>
                    <div className="text-muted-foreground mb-0.5 text-xs font-semibold uppercase">
                      {key}
                    </div>
                    <div className="border-border/40 bg-background/80 overflow-x-auto rounded border px-2.5 py-1.5">
                      {name === 'WebFetch' && key === 'url' && typeof value === 'string' ? (
                        <a
                          href={value}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground/80 hover:text-primary block font-mono text-xs leading-relaxed break-all whitespace-pre-wrap hover:underline"
                          data-testid="tool-webfetch-url-detail"
                        >
                          {value}
                        </a>
                      ) : (
                        <pre className="text-foreground/80 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                          {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {output && (
                <div className="mt-2">
                  <div className="text-muted-foreground mb-1 text-xs font-semibold uppercase">
                    {t('tools.output')}
                  </div>
                  {name === 'WebFetch' || name === 'WebSearch' ? (
                    <div className="border-border/40 bg-background/80 text-foreground/80 rounded border px-2.5 py-1.5 text-sm">
                      <MessageContent content={output} />
                    </div>
                  ) : (
                    <div className="border-border/40 bg-background/80 rounded border px-2.5 py-1.5">
                      <pre
                        className="text-muted-foreground font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
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
                    className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors"
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
}

function FileLink({
  filePath,
  displayPath,
  defaultEditor,
}: {
  filePath: string;
  displayPath: string | null;
  defaultEditor: Editor;
}) {
  const { t } = useTranslation();
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
            className="text-muted-foreground hover:text-primary min-w-0 truncate font-mono text-xs hover:underline"
          >
            {displayPath}
          </a>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              openFileInEditor(filePath, defaultEditor);
            }}
            className="text-muted-foreground hover:text-primary min-w-0 truncate text-left font-mono text-xs hover:underline"
          >
            {displayPath}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent>{editorTitle}</TooltipContent>
    </Tooltip>
  );
}
