import { ListTodo, X, ChevronDown, ChevronUp, Circle, CircleDot, CircleCheck } from 'lucide-react';
import { motion } from 'motion/react';
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
    requestAnimationFrame(() => {
      const targetTop = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
      container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    });
  }, [scrollTargetIdx, minimized, todos]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="absolute right-4 top-1/2 z-20 w-64 -translate-y-1/2 rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <ListTodo className="icon-sm text-muted-foreground" />
        <span className="flex-1 text-xs font-medium">{t('todoPanel.title')}</span>
        <motion.span
          key={`${progress.completed}/${progress.total}`}
          initial={{ scale: 1.2 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.2 }}
          className={cn(
            'text-xs font-mono px-1.5 py-0.5 rounded-full transition-colors duration-300',
            allDone
              ? 'bg-status-success/10 text-status-success/80'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {progress.completed}/{progress.total}
        </motion.span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setMinimized((v) => !v)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted"
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
              onClick={onDismiss}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted"
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
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <motion.div
                className={cn(
                  'h-full rounded-full',
                  allDone ? 'bg-status-success/80' : 'bg-status-info/80',
                )}
                initial={false}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              />
            </div>
          </div>

          {/* Animated todo list */}
          <ScrollArea viewportRef={listRef} className="max-h-64">
            <div className="space-y-1 px-3 py-1 pb-2">
              {todos.map((todo, i) => (
                <motion.div
                  key={todo.content}
                  className="flex items-start gap-2"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2, delay: i * 0.03 }}
                >
                  <motion.div
                    className="mt-0.5 flex-shrink-0"
                    key={`${todo.content}-${todo.status}`}
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  >
                    {todo.status === 'completed' ? (
                      <CircleCheck className="icon-sm text-status-success/80" />
                    ) : todo.status === 'in_progress' ? (
                      <CircleDot className="icon-sm animate-pulse text-status-info" />
                    ) : (
                      <Circle className="icon-sm text-muted-foreground/50" />
                    )}
                  </motion.div>
                  <span
                    className={cn(
                      'text-xs leading-relaxed transition-all duration-300',
                      todo.status === 'completed' && 'text-muted-foreground line-through',
                      todo.status === 'in_progress' && 'text-foreground font-medium',
                      todo.status === 'pending' && 'text-muted-foreground',
                    )}
                  >
                    {todo.content}
                  </span>
                </motion.div>
              ))}
            </div>
          </ScrollArea>
        </>
      )}
    </motion.div>
  );
}
