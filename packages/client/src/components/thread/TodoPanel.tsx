import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { ListTodo, X, ChevronDown, ChevronUp, Circle, CircleDot, CircleCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TodoItem } from '@/components/tool-cards/utils';

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
    const wrapper = container.firstElementChild as HTMLElement | null;
    if (!wrapper || scrollTargetIdx >= wrapper.children.length) return;
    const el = wrapper.children[scrollTargetIdx] as HTMLElement;
    // scrollTo the target, centering it in the container
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
      className="absolute top-1/2 -translate-y-1/2 right-4 z-20 w-64 rounded-lg border border-border bg-card/95 backdrop-blur-sm shadow-lg"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <ListTodo className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium flex-1">{t('todoPanel.title')}</span>
        <motion.span
          key={`${progress.completed}/${progress.total}`}
          initial={{ scale: 1.2 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.2 }}
          className={cn(
            'text-xs font-mono px-1.5 py-0.5 rounded-full transition-colors duration-300',
            allDone ? 'bg-status-success/10 text-status-success/80' : 'bg-muted text-muted-foreground'
          )}
        >
          {progress.completed}/{progress.total}
        </motion.span>
        <button
          onClick={() => setMinimized((v) => !v)}
          className="p-0.5 rounded hover:bg-muted transition-colors text-muted-foreground"
          title={minimized ? t('todoPanel.expand') : t('todoPanel.minimize')}
        >
          {minimized ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
        </button>
        <button
          onClick={onDismiss}
          className="p-0.5 rounded hover:bg-muted transition-colors text-muted-foreground"
          title={t('todoPanel.dismiss')}
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {!minimized && (
        <>
          {/* Progress bar */}
          <div className="px-3 pt-2">
            <div className="h-1 rounded-full bg-muted overflow-hidden">
              <motion.div
                className={cn(
                  'h-full rounded-full',
                  allDone ? 'bg-status-success/80' : 'bg-status-info/80'
                )}
                initial={false}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              />
            </div>
          </div>

          {/* Animated todo list */}
          <div ref={listRef} className="px-3 pb-2 max-h-64 overflow-y-auto">
            <div className="space-y-1 py-1">
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
                      <CircleCheck className="h-3.5 w-3.5 text-status-success/80" />
                    ) : todo.status === 'in_progress' ? (
                      <CircleDot className="h-3.5 w-3.5 text-status-info animate-pulse" />
                    ) : (
                      <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />
                    )}
                  </motion.div>
                  <span
                    className={cn(
                      'text-xs leading-relaxed transition-all duration-300',
                      todo.status === 'completed' && 'text-muted-foreground line-through',
                      todo.status === 'in_progress' && 'text-foreground font-medium',
                      todo.status === 'pending' && 'text-muted-foreground'
                    )}
                  >
                    {todo.content}
                  </span>
                </motion.div>
              ))}
            </div>
          </div>
        </>
      )}
    </motion.div>
  );
}
