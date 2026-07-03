import { ListTodo, X, ChevronDown, ChevronUp, Circle, CircleDot, CircleCheck } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import type { TodoItem } from '@/components/tool-cards/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface TodoPanelProps {
  todos: TodoItem[];
  progress: { completed: number; total: number };
  onDismiss: () => void;
}

export function TodoPanel({ todos, progress, onDismiss }: TodoPanelProps) {
  const { t } = useTranslation();
  const [minimized, setMinimized] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const allDone = progress.completed === progress.total;

  // Auto-scroll to the in_progress (or last completed) item
  const activeIdx = todos.findIndex((t) => t.status === 'in_progress');
  const scrollTargetIdx = activeIdx >= 0 ? activeIdx : progress.completed - 1;
  useEffect(() => {
    if (scrollTargetIdx < 0 || minimized || !listRef.current) return;
    const container = listRef.current;
    // Radix ScrollArea wraps our content in an extra div, so descend twice.
    const wrapper = container.firstElementChild?.firstElementChild as HTMLElement | null;
    if (!wrapper || scrollTargetIdx >= wrapper.children.length) return;
    const el = wrapper.children[scrollTargetIdx] as HTMLElement;
    const frameId = requestAnimationFrame(() => {
      const targetTop = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
      container.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frameId);
  }, [scrollTargetIdx, minimized, todos]);

  return (
    <div className="border-border bg-card/95 absolute top-1/2 right-4 z-20 w-64 -translate-y-1/2 rounded-lg border shadow-lg backdrop-blur-xs">
      {/* Header */}
      <div className="border-border/50 flex items-center gap-2 border-b px-3 py-2">
        <ListTodo className="icon-sm text-muted-foreground" />
        <span className="flex-1 text-xs font-medium">{t('todoPanel.title')}</span>
        <span
          className={cn(
            'text-xs font-mono px-1.5 py-0.5 rounded-full',
            allDone
              ? 'bg-status-success/10 text-status-success/80'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {progress.completed}/{progress.total}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setMinimized((v) => !v)}
              className="text-muted-foreground hover:bg-muted rounded p-0.5"
              aria-label={minimized ? t('todoPanel.expand') : t('todoPanel.minimize')}
            >
              {minimized ? <ChevronDown className="icon-xs" /> : <ChevronUp className="icon-xs" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {minimized ? t('todoPanel.expand') : t('todoPanel.minimize')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDismiss}
              className="text-muted-foreground hover:bg-muted rounded p-0.5"
              aria-label={t('todoPanel.dismiss')}
            >
              <X className="icon-xs" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('todoPanel.dismiss')}</TooltipContent>
        </Tooltip>
      </div>

      {!minimized && (
        <>
          {/* Progress bar */}
          <div className="px-3 pt-2">
            <div className="bg-muted h-1 overflow-hidden rounded-full">
              <div
                className={cn(
                  'h-full rounded-full',
                  allDone ? 'bg-status-success/80' : 'bg-status-info/80',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          <ScrollArea viewportRef={listRef} className="max-h-64">
            <div className="space-y-1 px-3 py-1 pb-2">
              {todos.map((todo) => (
                <div key={todo.content} className="flex items-start gap-2">
                  <div className="mt-0.5 shrink-0" key={`${todo.content}-${todo.status}`}>
                    {todo.status === 'completed' ? (
                      <CircleCheck className="icon-sm text-status-success/80" />
                    ) : todo.status === 'in_progress' ? (
                      <CircleDot className="icon-sm text-status-info" />
                    ) : (
                      <Circle className="icon-sm text-muted-foreground/50" />
                    )}
                  </div>
                  <span
                    className={cn(
                      'text-xs leading-relaxed',
                      todo.status === 'completed' && 'text-muted-foreground line-through',
                      todo.status === 'in_progress' && 'text-foreground font-medium',
                      todo.status === 'pending' && 'text-muted-foreground',
                    )}
                  >
                    {todo.content}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  );
}
