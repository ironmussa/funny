import { Circle, CircleDot, CircleCheck } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { TodoItem } from './utils';

export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="space-y-1 py-1">
      {todos.map((todo, i) => (
        <div key={`todo-${i}`} className="flex items-start gap-2">
          {todo.status === 'completed' ? (
            <CircleCheck className="icon-sm text-status-success/80 mt-0.5 shrink-0" />
          ) : todo.status === 'in_progress' ? (
            <CircleDot className="icon-sm text-status-info mt-0.5 shrink-0 animate-pulse" />
          ) : (
            <Circle className="icon-sm text-muted-foreground/50 mt-0.5 shrink-0" />
          )}
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
  );
}
