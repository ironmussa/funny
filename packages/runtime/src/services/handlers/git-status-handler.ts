/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: git:changed
 * @domain emits: git:status
 *
 * Emits git status via WebSocket when file-modifying tools are executed.
 * Uses per-thread debouncing to avoid flooding getStatusSummary().
 */

import { emitGitStatusForThread } from '../../utils/git-status-helpers.js';
import type { GitChangedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

// Per-thread debounce state
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

export const gitStatusHandler: EventHandler<'git:changed'> = {
  name: 'emit-git-status-on-change',
  event: 'git:changed',

  action(event: GitChangedEvent, ctx) {
    const { threadId } = event;

    // Clear any pending timer for this thread
    const existing = pendingTimers.get(threadId);
    if (existing) clearTimeout(existing);

    // Schedule the actual work after debounce period
    pendingTimers.set(
      threadId,
      setTimeout(() => {
        pendingTimers.delete(threadId);
        ctx.log(`Emitting git status for thread ${threadId} (debounced, tool: ${event.toolName})`);
        // Drift detection is only safe when this thread's own agent could have
        // run a checkout — i.e., a Bash tool call. Write/Edit/NotebookEdit
        // tools cannot change the branch, so trusting the current checkout in
        // those cases would let a parallel thread's checkout silently rewrite
        // this thread's branch.
        emitGitStatusForThread(
          { ...event, detectBranchDrift: event.toolName === 'Bash' },
          ctx,
        ).catch((err) => {
          ctx.log(`Failed to emit git status for thread ${threadId}: ${err?.message ?? err}`);
        });
      }, DEBOUNCE_MS),
    );
  },
};

/** Clear pending debounce timer for a thread (e.g. on thread deletion). */
export function clearGitStatusDebounce(threadId: string): void {
  const timer = pendingTimers.get(threadId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(threadId);
  }
}
