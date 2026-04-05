/**
 * Reusable selectors for thread state.
 * Eliminates deep property chain access (Law of Demeter violations)
 * and provides a stable API for common derived values.
 *
 * ## Zustand selector hooks
 *
 * The `useActive*` hooks below subscribe to individual slices of
 * `activeThread` so components only re-render when that specific slice
 * changes — not on every WebSocket update.
 *
 * Prefer these hooks over `useThreadStore(s => s.activeThread)` when a
 * component only needs a narrow piece of the active thread.
 */

import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { AgentInitInfo, ThreadWithMessages } from './thread-store';
import { useThreadStore } from './thread-store';

/** activeThread minus the high-churn array fields (messages, events). */
export type ActiveThreadCore = Omit<
  ThreadWithMessages,
  'messages' | 'threadEvents' | 'compactionEvents'
>;

/** Get the last message of a thread, or undefined. */
export function selectLastMessage(thread: ThreadWithMessages | null) {
  if (!thread?.messages?.length) return undefined;
  return thread.messages[thread.messages.length - 1];
}

/** Get the first (oldest) message of a thread, or undefined. */
export function selectFirstMessage(thread: ThreadWithMessages | null) {
  if (!thread?.messages?.length) return undefined;
  return thread.messages[0];
}

/** Get the last message's tool calls count, or 0. */
export function selectLastMessageToolCallCount(thread: ThreadWithMessages | null): number {
  const msg = selectLastMessage(thread);
  return msg?.toolCalls?.length ?? 0;
}

/** Check if a thread is in a terminal state (not expecting more output). */
export function selectIsTerminal(thread: ThreadWithMessages | null): boolean {
  if (!thread) return true;
  return ['completed', 'failed', 'stopped', 'interrupted'].includes(thread.status);
}

// ── Granular Zustand selector hooks ───────────────────────────────────
//
// These subscribe to narrow slices of `activeThread` so components only
// re-render when the specific slice changes — not on every WS update.

/** Subscribe to the active thread's status only. */
export function useActiveThreadStatus() {
  return useThreadStore((s) => s.activeThread?.status ?? null);
}

/** Subscribe to the active thread's ID only. */
export function useActiveThreadId() {
  return useThreadStore((s) => s.activeThread?.id ?? null);
}

/**
 * Subscribe to the active thread's `initInfo`.
 *
 * Returns a stable reference: the previous value is kept unless the
 * underlying tools/cwd/model actually changed, avoiding re-renders from
 * unrelated `activeThread` updates.
 */
export function useActiveInitInfo(): AgentInitInfo | undefined {
  const prevRef = useRef<AgentInitInfo | undefined>(undefined);

  return useThreadStore((s) => {
    const next = s.activeThread?.initInfo;
    if (!next) {
      prevRef.current = undefined;
      return undefined;
    }
    const prev = prevRef.current;
    if (
      prev &&
      prev.cwd === next.cwd &&
      prev.model === next.model &&
      prev.tools.length === next.tools.length &&
      prev.tools.every((t, i) => t === next.tools[i])
    ) {
      return prev; // same value — reuse old reference
    }
    prevRef.current = next;
    return next;
  });
}

/** Subscribe to the active thread's messages array.
 *  Returns the same reference when the array hasn't changed, preventing
 *  downstream memo comparators from failing on status-only store updates. */
export function useActiveMessages() {
  return useThreadStore((s) => s.activeThread?.messages ?? null);
}

/** Subscribe to the active thread's threadEvents array. */
export function useActiveThreadEvents() {
  return useThreadStore((s) => s.activeThread?.threadEvents);
}

/** Subscribe to the active thread's compactionEvents array. */
export function useActiveCompactionEvents() {
  return useThreadStore((s) => s.activeThread?.compactionEvents);
}

/**
 * Subscribe to the active thread excluding messages/events arrays.
 *
 * During agent streaming, `messages` changes on every WS batch (~20×/sec).
 * This selector strips those high-churn arrays and uses `useShallow` so the
 * returned reference stays stable when only messages changed — preventing
 * the consumer from re-rendering on every batch.
 *
 * Pair with `useActiveMessages()` for message data.
 */
export function useActiveThreadCore(): ActiveThreadCore | null {
  return useThreadStore(
    useShallow((s) => {
      const t = s.activeThread;
      if (!t) return null;
      // Destructure out the high-churn arrays; keep everything else.
      // useShallow compares remaining keys by reference — stable when
      // only messages/events changed (spread preserves sibling refs).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { messages, threadEvents, compactionEvents, ...core } = t;
      return core;
    }),
  );
}
