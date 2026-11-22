/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: core
 * @domain type: pipeline-helpers
 * @domain layer: application
 *
 * Waiting for the helper agents a git pipeline starts (reviewer, corrector,
 * test fixer, pre-commit fixer) to finish.
 */
import { sleep as effectSleep } from '@funny/shared/async';

import { threadEventBus } from '../thread-event-bus.js';

/**
 * Wait for an agent to complete via the event bus. Rejects with
 * `Pipeline cancelled` when `signal` aborts; both listeners are removed
 * either way.
 */
export function waitForAgentCompletion(
  threadId: string,
  signal: AbortSignal,
): Promise<{ status: string }> {
  return new Promise((resolve, reject) => {
    const onCompleted = (event: { threadId: string; status: string }) => {
      if (event.threadId !== threadId) return;
      cleanup();
      resolve({ status: event.status });
    };

    const onAbort = () => {
      cleanup();
      reject(new Error('Pipeline cancelled'));
    };

    const cleanup = () => {
      threadEventBus.removeListener('agent:completed', onCompleted as any);
      signal.removeEventListener('abort', onAbort);
    };

    threadEventBus.on('agent:completed', onCompleted as any);
    signal.addEventListener('abort', onAbort);

    if (signal.aborted) {
      cleanup();
      reject(new Error('Pipeline cancelled'));
    }
  });
}

/** Poll-based agent completion (used for the test fixer and the pre-commit fixer). */
export async function waitForAgentCompletionPoll(
  threadId: string,
  timeoutMs = 300_000,
): Promise<void> {
  const { isAgentRunning } = await import('../agent-runner-control.js');
  const start = Date.now();
  const pollInterval = 1000;

  while (Date.now() - start < timeoutMs) {
    if (!isAgentRunning(threadId)) return;
    await effectSleep(pollInterval);
  }

  throw new Error(`Agent timed out after ${timeoutMs}ms`);
}
