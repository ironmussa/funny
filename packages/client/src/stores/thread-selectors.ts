/**
 * Reusable selectors for thread state.
 * Eliminates deep property chain access (Law of Demeter violations)
 * and provides a stable API for common derived values.
 */

import type { ThreadWithMessages } from './thread-store';

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
