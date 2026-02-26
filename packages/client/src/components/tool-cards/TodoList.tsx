import { Circle, CircleDot, CircleCheck } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { TodoItem } from './utils';

export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="space-y-1 py-1">
      {todos.map((todo, i) => (
        <div key={`todo-${i}`} className="flex items-start gap-2">
          {todo.status === 'completed' ? (
            <CircleCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-status-success/80" />
          ) : todo.status === 'in_progress' ? (
            <CircleDot className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 animate-pulse text-status-info" />
          ) : (
            <Circle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
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
