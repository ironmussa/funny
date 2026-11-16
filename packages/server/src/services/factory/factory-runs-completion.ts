/**
 * Issue-factory run completion (change issue-factory, phase 2). Called when a
 * runner persists a terminal status for a thread (`data-message-handlers.ts` →
 * `notifyTerminalStatusPersisted`) — the durable "thread finished" signal — so a
 * run completes without polling and without the enabler having a browser open.
 *
 * Phase 2 runs a single "implement" thread. When it finishes:
 *   - completed → `waiting_human` (non-terminal): the agent produced a branch /
 *     PR for a person to carry forward. Non-terminal keeps the issue from being
 *     re-admitted; phase 4's stop/retry/take-over frees the slot. The CI + merge
 *     steps that would advance it automatically arrive in phase 3.
 *   - otherwise → `failed` (terminal). The watcher re-admits a failed issue up
 *     to `MAX_ATTEMPTS` times in all.
 *   - `waiting_human` frees the factory's concurrency slot (it holds no agent)
 *     but still blocks re-admitting its issue.
 *
 * @domain subdomain: Issue Factory
 * @domain type: app-service
 * @domain layer: application
 */

import { log } from '../../lib/logger.js';
import { createFactoryRunsRepository } from './factory-runs.js';

/**
 * Complete the factory run that owns `threadId`, if any. Idempotent: only a run
 * still in flight is advanced; any other thread is ignored.
 */
export async function onFactoryThreadTerminal(threadId: string, status: string): Promise<void> {
  const runs = createFactoryRunsRepository();
  const found = await runs.findByThreadId(threadId);
  if (found.isErr()) {
    log.error('Failed to look up factory run for terminal thread', {
      namespace: 'factory',
      threadId,
      error: found.error.message,
    });
    return;
  }
  const run = found.value;
  if (!run) return;
  // Only an in-flight run (its implement step is the current one) is advanced.
  if (run.currentStep !== 'implement') return;

  const completed = status === 'completed';
  // Only a run still `working` moves: a second terminal signal (the runner's
  // event plus the watcher's reconcile) or a stop that raced it changes nothing.
  const updated = await runs.advance(run.id, 'working', {
    state: completed ? 'waiting_human' : 'failed',
    currentStep: null,
  });
  if (updated.isErr()) {
    log.error('Failed to complete factory run', {
      namespace: 'factory',
      threadId,
      runId: run.id,
      error: updated.error.message,
    });
    return;
  }
  if (!updated.value) return;
  log.info('Issue factory run completed', {
    namespace: 'factory',
    runId: run.id,
    issue: run.issueNumber,
    status,
    state: completed ? 'waiting_human' : 'failed',
  });
}
