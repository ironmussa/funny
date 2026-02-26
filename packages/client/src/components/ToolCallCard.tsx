import AnsiToHtml from 'ansi-to-html';
import { ChevronRight, Wrench, ListTodo, Check } from 'lucide-react';
import { useState, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';

import { AskQuestionCard } from './tool-cards/AskQuestionCard';
import { BashCard } from './tool-cards/BashCard';
import { EditFileCard } from './tool-cards/EditFileCard';
import { ExitPlanModeCard } from './tool-cards/ExitPlanModeCard';
import { PlanCard } from './tool-cards/PlanCard';
import { ReadFileCard } from './tool-cards/ReadFileCard';
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
}

export const ToolCallCard = memo(
  function ToolCallCard({
    name,
    input,
    output,
    onRespond,
    hideLabel,
    planText,
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

    // SECURITY: escapeXML must remain true to prevent XSS via dangerouslySetInnerHTML
    const ansiConverter = useMemo(
      () => new AnsiToHtml({ fg: '#a1a1aa', bg: 'transparent', newline: false, escapeXML: true }),
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
        />
      );
    if (isPlan) return <PlanCard parsed={parsed} output={output} hideLabel={hideLabel} />;
    if (name === 'Bash') return <BashCard parsed={parsed} output={output} hideLabel={hideLabel} />;
    if (name === 'Read')
      return <ReadFileCard parsed={parsed} output={output} hideLabel={hideLabel} />;
    if (name === 'Write') return <WriteFileCard parsed={parsed} hideLabel={hideLabel} />;
    if (name === 'Edit') return <EditFileCard parsed={parsed} hideLabel={hideLabel} />;
    if (name === 'AskUserQuestion')
      return (
        <AskQuestionCard
          parsed={parsed}
          onRespond={output ? undefined : onRespond}
          output={output}
          hideLabel={hideLabel}
        />
      );

    return (
      <div className="max-w-full overflow-hidden text-sm">
        <button
          type="button"
          aria-expanded={expanded}
          className="w-full cursor-pointer rounded-md text-left transition-colors hover:bg-accent/30"
          onClick={() => setExpanded(!expanded)}
        >
          <div className="flex w-full items-center gap-2 overflow-hidden px-3 py-1.5 text-left text-xs">
            <ChevronRight
              className={cn(
                'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
                expanded && 'rotate-90',
              )}
            />
            {!hideLabel &&
              (isTodo ? (
                <ListTodo className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
              ) : (
                <Wrench className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
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
                  return editorUri ? (
                    <a
                      href={editorUri}
                      onClick={(e) => e.stopPropagation()}
                      className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
                      title={editorTitle}
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
                      title={editorTitle}
                    >
                      {displayPath}
                    </button>
                  );
                })()
              ) : (
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {summary}
                </span>
              ))}
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
          <div className="overflow-hidden border-t border-border/40 px-3 pb-2 pt-0">
            {isTodo && todos ? (
              <TodoList todos={todos} />
            ) : (
              <>
                <div className="mt-1.5 space-y-1.5">
                  {Object.entries(parsed).map(([key, value]) => (
                    <div key={key}>
                      <div className="mb-0.5 text-xs font-semibold uppercase text-muted-foreground">
                        {key}
                      </div>
                      <div className="overflow-x-auto rounded border border-border/40 bg-background/80 px-2.5 py-1.5">
                        <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/80">
                          {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
                {output && (
                  <div className="mt-2">
                    <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                      {t('tools.output')}
                    </div>
                    <div className="max-h-60 overflow-hidden rounded border border-border/40 bg-background/80 px-2.5 py-1.5">
                      <pre
                        className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground"
                        dangerouslySetInnerHTML={{ __html: htmlOutput! }}
                      />
                    </div>
                  </div>
                )}
                {onRespond && !output && (
                  <div className="flex justify-end pt-2">
                    <button
                      onClick={() => onRespond('Accepted')}
                      className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      <Check className="h-3 w-3" />
                      {t('tools.respond')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
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
      prev.planText === next.planText
    );
  },
);
