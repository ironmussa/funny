/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Requests to a factory run's agent threads on their runner (issue-factory
 * phase 4, factory-flow-execution): stop them when a run is stopped, and send
 * a follow-up when a later agent step continues the run's first thread.
 *
 * The threads are the factory enabler's, so each request is signed as the
 * enabler. The runner is the one the thread runs on, resolved from the
 * thread's own route (`withRunnerFor` with a `request` target, the same rule
 * as the proxy): a sandbox thread's own sandbox runner, any other thread its
 * project's runner — certified for the enabler, never another user's runner.
 * A follow-up to a sandbox stopped while idle wakes it first, as the proxy does.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { and, eq, inArray, isNotNull, ne, notInArray } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { authorizedRunnerRequests, runnerActor, withRunnerFor } from '../runner-access/index.js';
import type { RunnerPorts } from '../runner-thread-launcher.js';
import { sandboxWaker } from '../thread-sandboxes/sandbox-lifecycle.js';

const ACTIVE_STATUSES = ['running', 'waiting', 'pending', 'setting_up'];

type PostError = { message: string; sandboxAsleep: boolean };

interface ThreadRequest {
  method: 'POST' | 'DELETE';
  path: string;
  /** Routing context: a `threadId` here sends a non-thread route to that thread's runner. */
  query?: Record<string, string>;
  body: unknown;
}

/** POST `path` (a thread route) to the thread's runner, as `userId`. */
function postToThread(
  ports: RunnerPorts,
  userId: string,
  path: string,
  body: unknown,
): Promise<Result<void, PostError>> {
  return sendToThreadRunner(ports, userId, { method: 'POST', path, body });
}

/** Send a request to the runner a thread runs on, as `userId`. */
async function sendToThreadRunner(
  ports: RunnerPorts,
  userId: string,
  { method, path, query = {}, body }: ThreadRequest,
): Promise<Result<void, PostError>> {
  const sink = authorizedRunnerRequests(ports.requests);
  try {
    const sent = await withRunnerFor(
      runnerActor({ userId }),
      { kind: 'request', path, query },
      ports.presence,
      (actor, runner, proof) =>
        sink.send(actor, runner, proof, {
          method,
          path,
          headers: { 'Content-Type': 'application/json' },
          body: body === null ? null : JSON.stringify(body),
        }),
    );
    if (sent.isErr()) {
      const reason = sent.error.reason;
      return err({
        message: `the thread's runner is unavailable (${reason})`,
        sandboxAsleep: reason === 'thread-sandbox-unavailable',
      });
    }
    if (sent.value.status < 400) return ok(undefined);
    const reason = runnerErrorText(sent.value.body);
    return err({
      message: `the runner answered ${sent.value.status}${reason ? `: ${reason}` : ''}`,
      sandboxAsleep: false,
    });
  } catch (error) {
    return err({
      message: error instanceof Error ? error.message : String(error),
      sandboxAsleep: false,
    });
  }
}

/** A runner's JSON error body (`resultToResponse`). */
const runnerErrorBody = z.object({ error: z.string() });

/** The `error` of a runner's JSON error body, so a refusal says why (a branch mismatch). */
function runnerErrorText(body: string | null | undefined): string | null {
  if (!body) return null;
  const parsed = parseStoredJson(runnerErrorBody, body, 'runner error');
  return parsed.ok ? parsed.value.error.slice(0, 500) : null;
}

/** Start a regression proof job on the thread's runner. Returns the proof id. */
export async function startRegressionProofOnRunner(
  ports: RunnerPorts,
  userId: string,
  threadId: string,
  body: Record<string, unknown>,
): Promise<Result<{ proofId: string; state: string }, string>> {
  const sink = authorizedRunnerRequests(ports.requests);
  const path = `/api/threads/${threadId}/regression-proof`;
  try {
    const sent = await withRunnerFor(
      runnerActor({ userId }),
      { kind: 'request', path, query: {} },
      ports.presence,
      (actor, runner, proof) =>
        sink.send(actor, runner, proof, {
          method: 'POST',
          path,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    );
    if (sent.isErr()) return err(`runner unavailable: ${sent.error.reason}`);
    if (sent.value.status >= 400) {
      const reason = runnerErrorText(sent.value.body);
      return err(`runner answered ${sent.value.status}${reason ? `: ${reason}` : ''}`);
    }
    const parsed = parseStoredJson(
      z.object({ proofId: z.string(), state: z.string() }),
      sent.value.body ?? '{}',
      'proof start response',
    );
    if (!parsed.ok) return err('invalid proof start response');
    return ok(parsed.value);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

/** Poll a regression proof job on the thread's runner. */
export async function pollRegressionProofOnRunner(
  ports: RunnerPorts,
  userId: string,
  threadId: string,
  proofId: string,
): Promise<Result<{ state: string; result?: unknown }, string>> {
  const sink = authorizedRunnerRequests(ports.requests);
  const path = `/api/threads/${threadId}/regression-proof/${proofId}`;
  try {
    const sent = await withRunnerFor(
      runnerActor({ userId }),
      { kind: 'request', path, query: {} },
      ports.presence,
      (actor, runner, proof) =>
        sink.send(actor, runner, proof, {
          method: 'GET',
          path,
          headers: {},
          body: null,
        }),
    );
    if (sent.isErr()) return err(`runner unavailable: ${sent.error.reason}`);
    if (sent.value.status === 404) return err('proof-not-found');
    if (sent.value.status >= 400) {
      const reason = runnerErrorText(sent.value.body);
      return err(`runner answered ${sent.value.status}${reason ? `: ${reason}` : ''}`);
    }
    const parsed = parseStoredJson(
      z.object({ state: z.string(), result: z.unknown().optional() }),
      sent.value.body ?? '{}',
      'proof poll response',
    );
    if (!parsed.ok) return err('invalid proof poll response');
    return ok(parsed.value);
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
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        inArray(threads.id, threadIds),
        eq(threads.userId, userId),
        inArray(threads.status, ACTIVE_STATUSES),
      ),
    );
  for (const thread of active) {
    const stopped = await postToThread(ports, userId, `/api/threads/${thread.id}/stop`, null);
    if (stopped.isErr()) {
      log.warn('Failed to stop a factory thread', {
        namespace: 'factory',
        threadId: thread.id,
        error: stopped.error.message,
      });
    }
  }
}

/**
 * Send `content` as a follow-up to the enabler's thread, which runs its agent
 * again. With `expectedBranch` (the run's branch) the runner refuses it when
 * the thread's worktree was switched to another branch, so the step fails
 * with that reason instead of pushing the wrong branch.
 */
export async function sendFactoryFollowUp(
  ports: RunnerPorts,
  userId: string,
  threadId: string,
  content: string,
  expectedBranch?: string,
): Promise<Result<void, string>> {
  const [thread] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)));
  if (!thread) return err('the thread no longer exists');
  const path = `/api/threads/${threadId}/message`;
  const message = expectedBranch ? { content, expectedBranch } : { content };
  const sent = await postToThread(ports, userId, path, message);
  if (sent.isOk() || !sent.error.sandboxAsleep) return sent.mapErr((e) => e.message);
  // The run waited (e.g. on CI) long enough for its sandbox to sleep: wake it once.
  const waker = sandboxWaker();
  if (!waker) return err(sent.error.message);
  const woken = await waker.wake(threadId, userId);
  if (woken.isErr()) return err(`the sandbox could not be woken: ${woken.error.message}`);
  return (await postToThread(ports, userId, path, message)).mapErr((e) => e.message);
}

/**
 * Remove the worktree and local branch of a merged run's threads on the
 * enabler's runner (`DELETE /api/worktrees`, the route the client's worktree
 * cleanup uses), then clear them on the thread rows, as archiving does. The
 * pull request is merged, so the work lives on the default branch now; left
 * alone, every run would keep a worktree and a branch forever.
 *
 * Only idle worktree threads of the enabler on a local runner: a sandbox is
 * torn down with its own lifecycle, and a thread still running (a member
 * following up) keeps its checkout. Best effort: a runner that is offline
 * leaves them in place, and the merge is not affected.
 */
export async function cleanupFactoryWorktrees(
  ports: RunnerPorts,
  userId: string,
  threadIds: string[],
): Promise<void> {
  if (threadIds.length === 0) return;
  const rows = await db
    .select({
      id: threads.id,
      projectId: threads.projectId,
      worktreePath: threads.worktreePath,
      branch: threads.branch,
    })
    .from(threads)
    .where(
      and(
        inArray(threads.id, [...new Set(threadIds)]),
        eq(threads.userId, userId),
        eq(threads.mode, 'worktree'),
        ne(threads.runtime, 'sandbox'),
        isNotNull(threads.worktreePath),
        notInArray(threads.status, ACTIVE_STATUSES),
      ),
    );
  for (const thread of rows) {
    if (!thread.projectId || !thread.worktreePath) continue;
    const removed = await sendToThreadRunner(ports, userId, {
      method: 'DELETE',
      path: '/api/worktrees',
      query: { threadId: thread.id, projectId: thread.projectId },
      body: {
        projectId: thread.projectId,
        worktreePath: thread.worktreePath,
        branchName: thread.branch ?? undefined,
        deleteBranch: !!thread.branch,
      },
    });
    if (removed.isErr()) {
      log.warn('Failed to remove a merged factory run worktree', {
        namespace: 'factory',
        threadId: thread.id,
        error: removed.error.message,
      });
      continue;
    }
    await db
      .update(threads)
      .set({ worktreePath: null, branch: null })
      .where(eq(threads.id, thread.id));
    log.info('Removed a merged factory run worktree', {
      namespace: 'factory',
      threadId: thread.id,
      branch: thread.branch,
    });
  }
}
