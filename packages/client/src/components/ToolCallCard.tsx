import { useState, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Wrench, ListTodo, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatInput, getTodos, getFilePath, getSummary, getToolLabel, toVscodeUri } from './tool-cards/utils';
import { TodoList } from './tool-cards/TodoList';
import { AskQuestionCard } from './tool-cards/AskQuestionCard';
import { PlanCard } from './tool-cards/PlanCard';
import { BashCard } from './tool-cards/BashCard';
import { WriteFileCard } from './tool-cards/WriteFileCard';
import { EditFileCard } from './tool-cards/EditFileCard';

interface ToolCallCardProps {
  name: string;
  input: string | Record<string, unknown>;
  output?: string;
  onRespond?: (answer: string) => void;
}

export const ToolCallCard = memo(function ToolCallCard({ name, input, output, onRespond }: ToolCallCardProps) {
  const { t } = useTranslation();
  const isTodo = name === 'TodoWrite';
  const [expanded, setExpanded] = useState(!!onRespond || isTodo);
  const parsed = useMemo(() => formatInput(input), [input]);
  const label = getToolLabel(name, t);
  const summary = getSummary(name, parsed, t);

  const isPlan = typeof parsed.plan === 'string' && parsed.plan.length > 0;
  const todos = isTodo ? getTodos(parsed) : null;
  const filePath = getFilePath(name, parsed);

  // Specialized cards
  if (isPlan) return <PlanCard parsed={parsed} output={output} onRespond={onRespond} />;
  if (name === 'Bash') return <BashCard parsed={parsed} output={output} />;
  if (name === 'Write') return <WriteFileCard parsed={parsed} />;
  if (name === 'Edit') return <EditFileCard parsed={parsed} />;
  if (name === 'AskUserQuestion') return <AskQuestionCard parsed={parsed} onRespond={onRespond} />;

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 text-sm max-w-full overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-accent/30 transition-colors rounded-md overflow-hidden"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        {isTodo ? (
          <ListTodo className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <Wrench className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium font-mono text-foreground flex-shrink-0">{label}</span>
        {summary && (
          filePath ? (
            <a
              href={toVscodeUri(filePath)}
              onClick={(e) => e.stopPropagation()}
              className="text-muted-foreground truncate font-mono text-[11px] min-w-0 hover:text-primary hover:underline"
              title={t('tools.openInVSCode', { path: filePath })}
            >
              {summary}
            </a>
          ) : (
            <span className="text-muted-foreground truncate font-mono text-[11px] min-w-0">
              {summary}
            </span>
          )
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2 pt-0 border-t border-border/40 overflow-hidden">
          {isTodo && todos ? (
            <TodoList todos={todos} />
          ) : (
            <>
              <pre className="text-[11px] font-mono text-muted-foreground leading-relaxed whitespace-pre-wrap break-all mt-1.5">
                {JSON.stringify(parsed, null, 2)}
              </pre>
              {output && (
                <div className="mt-2">
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">{t('tools.output')}</div>
                  <div className="rounded bg-background/80 border border-border/40 px-2.5 py-1.5 overflow-x-auto max-h-60 overflow-y-auto">
                    <pre className="font-mono text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap break-all">{output}</pre>
                  </div>
                </div>
              )}
              {onRespond && !output && (
                <div className="flex justify-end pt-2">
                  <button
                    onClick={() => onRespond('Accepted')}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
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
  return prev.name === next.name && prev.input === next.input && prev.output === next.output;
});
