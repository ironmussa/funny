import { useMemo } from 'react';

import { formatInput, getTodos } from '@/components/tool-cards/utils';
import type { TodoItem } from '@/components/tool-cards/utils';
import { useThreadStore } from '@/stores/thread-store';

export interface TodoSnapshot {
  todos: TodoItem[];
  toolCallId: string;
  progress: { completed: number; total: number };
}

/**
 * Returns all TodoWrite snapshots in chronological order.
 * Each snapshot represents the full todo state at that point in the conversation.
 */
export function useTodoSnapshots(): TodoSnapshot[] {
  const messages = useThreadStore((s) => s.activeThread?.messages);

  return useMemo(() => {
    if (!messages) return [];
    const snapshots: TodoSnapshot[] = [];

    for (const msg of messages) {
      for (const tc of msg.toolCalls ?? []) {
        if (tc.name === 'TodoWrite') {
          const parsed = formatInput(tc.input);
          const todos = getTodos(parsed);
          if (todos && todos.length > 0) {
            const completed = todos.filter((t) => t.status === 'completed').length;
            snapshots.push({
              todos,
              toolCallId: tc.id,
              progress: { completed, total: todos.length },
            });
          }
        }
      }
    }

    return snapshots;
  }, [messages]);
}
