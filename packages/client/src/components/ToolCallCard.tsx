import { useState, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Wrench, ListTodo, Check } from 'lucide-react';
import AnsiToHtml from 'ansi-to-html';
import { cn } from '@/lib/utils';
import { formatInput, getTodos, getFilePath, getSummary, getToolLabel, toEditorUri, openFileInEditor, getEditorLabel } from './tool-cards/utils';
import { useSettingsStore } from '@/stores/settings-store';
import { TodoList } from './tool-cards/TodoList';
import { AskQuestionCard } from './tool-cards/AskQuestionCard';
import { PlanCard } from './tool-cards/PlanCard';
import { BashCard } from './tool-cards/BashCard';
import { WriteFileCard } from './tool-cards/WriteFileCard';
import { EditFileCard } from './tool-cards/EditFileCard';
import { ReadFileCard } from './tool-cards/ReadFileCard';
import { ExitPlanModeCard } from './tool-cards/ExitPlanModeCard';

interface ToolCallCardProps {
  name: string;
  input: string | Record<string, unknown>;
  output?: string;
  onRespond?: (answer: string) => void;
  /** When true, hides the tool label (used inside ToolCallGroup to avoid redundancy) */
  hideLabel?: boolean;
}

export const ToolCallCard = memo(function ToolCallCard({ name, input, output, onRespond, hideLabel }: ToolCallCardProps) {
  const { t } = useTranslation();
  const isTodo = name === 'TodoWrite';
  const [expanded, setExpanded] = useState(!!onRespond || isTodo);
  const parsed = useMemo(() => formatInput(input), [input]);
  const label = getToolLabel(name, t);
  const summary = getSummary(name, parsed, t);

  const isPlan = typeof parsed.plan === 'string' && parsed.plan.length > 0;
  const todos = isTodo ? getTodos(parsed) : null;
  const filePath = getFilePath(name, parsed);
  const defaultEditor = useSettingsStore(s => s.defaultEditor);

  // SECURITY: escapeXML must remain true to prevent XSS via dangerouslySetInnerHTML
  const ansiConverter = useMemo(() => new AnsiToHtml({ fg: '#a1a1aa', bg: 'transparent', newline: false, escapeXML: true }), []);
  const htmlOutput = useMemo(() => output ? ansiConverter.toHtml(output) : null, [ansiConverter, output]);

  // Truncated output preview for collapsed cards (strip ANSI for plain-text preview)
  const outputPreview = useMemo(() => {
    if (!output || expanded) return null;
    // Strip ANSI escape codes for the preview text
    // eslint-disable-next-line no-control-regex
    const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
    const firstLine = clean.split('\n').find(l => l.trim())?.trim();
    if (!firstLine) return null;
    return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
  }, [output, expanded]);

  // Specialized cards
  // ExitPlanMode must be checked before isPlan — its input contains a `plan` field
  // but needs approval buttons, which PlanCard doesn't provide.
  if (name === 'ExitPlanMode') return <ExitPlanModeCard plan={typeof parsed.plan === 'string' ? parsed.plan : undefined} onRespond={onRespond} />;
  if (isPlan) return <PlanCard parsed={parsed} output={output} hideLabel={hideLabel} />;
  if (name === 'Bash') return <BashCard parsed={parsed} output={output} hideLabel={hideLabel} />;
  if (name === 'Read') return <ReadFileCard parsed={parsed} output={output} hideLabel={hideLabel} />;
  if (name === 'Write') return <WriteFileCard parsed={parsed} hideLabel={hideLabel} />;
  if (name === 'Edit') return <EditFileCard parsed={parsed} hideLabel={hideLabel} />;
  if (name === 'AskUserQuestion') return <AskQuestionCard parsed={parsed} onRespond={output ? undefined : onRespond} output={output} hideLabel={hideLabel} />;

  return (
    <div className="text-sm max-w-full overflow-hidden">
      <div
        className="hover:bg-accent/30 transition-colors rounded-md cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs overflow-hidden">
          <ChevronRight
            className={cn(
              'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90'
            )}
          />
          {!hideLabel && (
            isTodo ? (
              <ListTodo className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            ) : (
              <Wrench className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            )
          )}
          {!hideLabel && (
            <span className="font-medium font-mono text-foreground flex-shrink-0">{label}</span>
          )}
          {summary && (
            filePath ? (
              (() => {
                const editorUri = toEditorUri(filePath, defaultEditor);
                const editorTitle = t('tools.openInEditor', { editor: getEditorLabel(defaultEditor), path: filePath });
                return editorUri ? (
                  <a
                    href={editorUri}
                    onClick={(e) => e.stopPropagation()}
                    className="text-muted-foreground truncate font-mono text-xs min-w-0 hover:text-primary hover:underline"
                    title={editorTitle}
                  >
                    {summary}
                  </a>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); openFileInEditor(filePath, defaultEditor); }}
                    className="text-muted-foreground truncate font-mono text-xs min-w-0 hover:text-primary hover:underline text-left"
                    title={editorTitle}
                  >
                    {summary}
                  </button>
                );
              })()
            ) : (
              <span className="text-muted-foreground truncate font-mono text-xs min-w-0">
                {summary}
              </span>
            )
          )}
        </div>
        {!expanded && outputPreview && (
          <div className="px-3 pb-1.5 -mt-0.5">
            <p className="text-xs font-mono text-muted-foreground/70 truncate leading-tight">
              → {outputPreview}
            </p>
          </div>
        )}
      </div>
      {expanded && (
        <div className="px-3 pb-2 pt-0 border-t border-border/40 overflow-hidden">
          {isTodo && todos ? (
            <TodoList todos={todos} />
          ) : (
            <>
              <div className="space-y-1.5 mt-1.5">
                {Object.entries(parsed).map(([key, value]) => (
                  <div key={key}>
                    <div className="text-xs font-semibold text-muted-foreground uppercase mb-0.5">{key}</div>
                    <div className="rounded bg-background/80 border border-border/40 px-2.5 py-1.5 overflow-x-auto">
                      <pre className="font-mono text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap break-all">
                        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
              {output && (
                <div className="mt-2">
                  <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">{t('tools.output')}</div>
                  <div className="rounded bg-background/80 border border-border/40 px-2.5 py-1.5 overflow-x-auto max-h-60 overflow-y-auto">
                    <pre
                      className="font-mono text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap break-all"
                      dangerouslySetInnerHTML={{ __html: htmlOutput! }}
                    />
                  </div>
                </div>
              )}
              {onRespond && !output && (
                <div className="flex justify-end pt-2">
                  <button
                    onClick={() => onRespond('Accepted')}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
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
}, (prev, next) => {
  return prev.name === next.name && prev.input === next.input && prev.output === next.output && prev.hideLabel === next.hideLabel && !!prev.onRespond === !!next.onRespond;
});
