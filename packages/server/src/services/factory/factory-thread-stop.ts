/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Stop the agent threads of a stopped factory run (issue-factory phase 4).
 * The threads are the factory enabler's, so each stop is signed as the
 * enabler and sent to the runner the thread runs on, certified as theirs
 * (`withRunnerFor`, `owned-runner`): never another user's runner. A thread
 * whose runner is not the enabler's is skipped (and audited by
 * `runner-access`).
 */

import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { authorizedRunnerRequests, runnerActor, withRunnerFor } from '../runner-access/index.js';
import type { RunnerPorts } from '../runner-thread-launcher.js';

const ACTIVE_STATUSES = ['running', 'waiting', 'pending'];

export async function stopFactoryThreads(
  ports: RunnerPorts,
  userId: string,
  threadIds: string[],
): Promise<void> {
  if (threadIds.length === 0) return;
  const active = await db
    .select({ id: threads.id, runnerId: threads.runnerId })
    .from(threads)
    .where(
      and(
        inArray(threads.id, threadIds),
        eq(threads.userId, userId),
        inArray(threads.status, ACTIVE_STATUSES),
      ),
    );
  const sink = authorizedRunnerRequests(ports.requests);
  for (const thread of active) {
    if (!thread.runnerId) continue;
    const sent = await withRunnerFor(
      runnerActor({ userId }),
      { kind: 'owned-runner', runnerId: thread.runnerId },
      ports.presence,
      async (actor, runner, proof) => {
        if (!(await sink.isAvailable(runner))) return;
        await sink.send(actor, runner, proof, {
          method: 'POST',
          path: `/api/threads/${thread.id}/stop`,
          headers: { 'Content-Type': 'application/json' },
          body: null,
        });
      },
    ).catch((error: unknown) => {
      log.warn('Failed to stop a factory thread', {
        namespace: 'factory',
        threadId: thread.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (sent?.isErr()) {
      log.warn('Skipped stopping a factory thread on a runner its owner does not own', {
        namespace: 'factory',
        threadId: thread.id,
        runnerId: thread.runnerId,
      });
    }
  }
}
