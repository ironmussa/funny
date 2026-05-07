import { useRef, useMemo } from 'react';

import { formatInput, getTodos } from '@/components/tool-cards/utils';
import type { TodoItem } from '@/components/tool-cards/utils';
import { useThreadMessages } from '@/stores/thread-context';

export interface TodoSnapshot {
  todos: TodoItem[];
  toolCallId: string;
  progress: { completed: number; total: number };
  /** If set, this TodoWrite came from a sub-agent (Task tool call with this ID). */
  parentToolCallId?: string;
}

export interface AgentTodos {
  /** Latest TodoWrite snapshot from the main agent (no parentToolCallId). */
  mainAgent: TodoSnapshot | null;
  /** Latest TodoWrite snapshot per sub-agent, keyed by parent Task tool call ID. */
  bySubAgent: Map<string, TodoSnapshot>;
}

/**
 * Extract only TodoWrite tool calls from messages.
 * Returns a stable reference when the TodoWrite calls haven't changed,
 * preventing downstream recomputes on every WS message update.
 */
function useTodoWriteCalls(): { id: string; input: any; parentToolCallId?: string }[] {
  const prevRef = useRef<{ id: string; input: any; parentToolCallId?: string }[]>([]);
  const messages = useThreadMessages();

  return useMemo(() => {
    if (!messages) {
      if (prevRef.current.length === 0) return prevRef.current;
      prevRef.current = [];
      return prevRef.current;
    }

    const calls: { id: string; input: any; parentToolCallId?: string }[] = [];
    for (const msg of messages) {
      for (const tc of msg.toolCalls ?? []) {
        if (tc.name === 'TodoWrite') calls.push(tc);
      }
    }

    const prev = prevRef.current;
    if (prev.length === calls.length && calls.every((c, i) => c === prev[i])) {
      return prev;
    }

    prevRef.current = calls;
    return calls;
  }, [messages]);
}

/**
 * Returns all TodoWrite snapshots in chronological order.
 * Each snapshot represents the full todo state at that point in the conversation.
 */
export function useTodoSnapshots(): TodoSnapshot[] {
  const todoCalls = useTodoWriteCalls();

  return useMemo(() => {
    if (todoCalls.length === 0) return [];
    const snapshots: TodoSnapshot[] = [];

    for (const tc of todoCalls) {
      const parsed = formatInput(tc.input);
      const todos = getTodos(parsed);
      if (todos && todos.length > 0) {
        const completed = todos.filter((t) => t.status === 'completed').length;
        snapshots.push({
          todos,
          toolCallId: tc.id,
          progress: { completed, total: todos.length },
          parentToolCallId: tc.parentToolCallId,
        });
      }
    }

    return snapshots;
  }, [todoCalls]);
}

/**
 * Returns the latest TodoWrite snapshot grouped by agent.
 * Main agent todos have no parentToolCallId; sub-agent todos are keyed by their parent Task ID.
 */
export function useTodoSnapshotsByAgent(): AgentTodos {
  const snapshots = useTodoSnapshots();

  return useMemo(() => {
    let mainAgent: TodoSnapshot | null = null;
    const bySubAgent = new Map<string, TodoSnapshot>();

    // Last snapshot per agent wins (represents the most recent state)
    for (const snap of snapshots) {
      if (snap.parentToolCallId) {
        bySubAgent.set(snap.parentToolCallId, snap);
      } else {
        mainAgent = snap;
      }
    }

    return { mainAgent, bySubAgent };
  }, [snapshots]);
}
