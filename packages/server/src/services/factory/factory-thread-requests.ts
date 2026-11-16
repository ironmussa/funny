/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Requests to a factory run's agent threads on their runner (issue-factory
 * phase 4, factory-flow-execution): stop them when a run is stopped, and send
 * a follow-up when a later agent step continues the run's first thread. The
 * threads are the factory enabler's, so each request is signed as the enabler
 * and sent to the runner the thread runs on, certified as theirs
 * (`withRunnerFor`, `owned-runner`): never another user's runner. A thread
 * whose runner is not the enabler's is refused (and audited by
 * `runner-access`).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';

import { db } from '../../db/index.js';
import { threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { authorizedRunnerRequests, runnerActor, withRunnerFor } from '../runner-access/index.js';
import type { RunnerPorts } from '../runner-thread-launcher.js';

const ACTIVE_STATUSES = ['running', 'waiting', 'pending'];

/** POST `path` for `threadId` on its runner, as `userId`; a message when it could not be sent. */
async function postToThread(
  ports: RunnerPorts,
  userId: string,
  thread: { id: string; runnerId: string | null },
  path: string,
  body: unknown,
): Promise<Result<void, string>> {
  if (!thread.runnerId) return err('the thread has no runner');
  const sink = authorizedRunnerRequests(ports.requests);
  try {
    const sent = await withRunnerFor(
      runnerActor({ userId }),
      { kind: 'owned-runner', runnerId: thread.runnerId },
      ports.presence,
      async (actor, runner, proof): Promise<Result<void, string>> => {
        if (!(await sink.isAvailable(runner))) return err("the enabler's runner is offline");
        const res = await sink.send(actor, runner, proof, {
          method: 'POST',
          path,
          headers: { 'Content-Type': 'application/json' },
          body: body === null ? null : JSON.stringify(body),
        });
        return res.status < 400 ? ok(undefined) : err(`the runner answered ${res.status}`);
      },
    );
    return sent.isErr() ? err("the thread's runner is not the enabler's") : sent.value;
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

/** Stop the running agent threads among `threadIds` (a stopped run). */
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
  for (const thread of active) {
    const stopped = await postToThread(
      ports,
      userId,
      thread,
      `/api/threads/${thread.id}/stop`,
      null,
    );
    if (stopped.isErr()) {
      log.warn('Failed to stop a factory thread', {
        namespace: 'factory',
        threadId: thread.id,
        error: stopped.error,
      });
    }
  }
}

/** Send `content` as a follow-up to the enabler's thread, which runs its agent again. */
export async function sendFactoryFollowUp(
  ports: RunnerPorts,
  userId: string,
  threadId: string,
  content: string,
): Promise<Result<void, string>> {
  const [thread] = await db
    .select({ id: threads.id, runnerId: threads.runnerId })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)));
  if (!thread) return err('the thread no longer exists');
  return postToThread(ports, userId, thread, `/api/threads/${threadId}/message`, { content });
}
