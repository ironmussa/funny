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
import { sendToThreadRunner, type ThreadRunnerError } from '../thread-runner-requests.js';
import { sandboxWaker } from '../thread-sandboxes/sandbox-lifecycle.js';
import {
  clearThreadWorkspace,
  requestThreadWorkspaceCleanup,
} from '../thread-workspace-cleanup.js';
import { RUNNER_UNAVAILABLE_PREFIX } from './factory-proof-runner.js';

const ACTIVE_STATUSES = ['running', 'waiting', 'pending', 'setting_up'];

/** Where the cleanup announces a changed thread row to its owner's browsers. */
export interface BrowserEventsPort {
  toUser(userId: string, event: Record<string, unknown>): void;
}

/** POST `path` (a thread route) to the thread's runner, as `userId`. */
async function postToThread(
  ports: RunnerPorts,
  userId: string,
  path: string,
  body: unknown,
): Promise<Result<void, ThreadRunnerError>> {
  return (await sendToThreadRunner(ports, userId, { method: 'POST', path, body })).map(
    () => undefined,
  );
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
    if (sent.isErr()) return err(`${RUNNER_UNAVAILABLE_PREFIX}${sent.error.reason}`);
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
    if (sent.isErr()) return err(`${RUNNER_UNAVAILABLE_PREFIX}${sent.error.reason}`);
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
 * enabler's runner (`requestThreadWorkspaceCleanup`, reason `factory-merged`),
 * as archiving does. The pull request is merged, so the work lives on the
 * default branch now; left alone, every run would keep a worktree and a branch
 * forever.
 *
 * Only idle worktree threads of the enabler on a local runner: a sandbox is
 * torn down with its own lifecycle, and a thread still running (a member
 * following up) keeps its checkout. Best effort: a runner that is offline
 * leaves them in place (recorded as a failed cleanup), and the merge is not
 * affected.
 *
 * Each cleared thread is announced to its owner as `thread:updated`, so an
 * open thread view stops pointing at the removed worktree without a reload.
 *
 * With `keepUnsaved` (a run that ended without a pull request) the runner
 * removes a worktree only when nothing would be lost with it, and the ones it
 * kept are returned. A runner that cannot answer (offline, or from before that
 * route) leaves the worktree in place, never deleting on a guess, and it is
 * returned too (with zero counts): unchecked is not clean.
 */
export async function cleanupFactoryWorktrees(
  ports: RunnerPorts,
  userId: string,
  threadIds: string[],
  browserEvents?: BrowserEventsPort,
  options: { keepUnsaved?: boolean } = {},
): Promise<KeptWorktree[]> {
  const kept: KeptWorktree[] = [];
  if (threadIds.length === 0) return kept;
  // A run that merged, or one that ended without a pull request ("no change").
  const reason = options.keepUnsaved ? 'ended-without-pr' : 'merged';
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
    const workspace = {
      id: thread.id,
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
      branch: thread.branch,
    };
    const removed = options.keepUnsaved
      ? await removeUnchangedWorktree(ports, userId, workspace)
      : (
          await requestThreadWorkspaceCleanup(ports, {
            userId,
            thread: workspace,
            deleteBranch: !!thread.branch,
            reason: 'factory-merged',
            origin: 'system',
          })
        ).map(() => null);
    if (removed.isErr()) {
      log.warn('Failed to remove a factory run worktree', {
        namespace: 'factory',
        threadId: thread.id,
        reason,
        error: removed.error,
      });
      // Not checked is not clean: the caller must not take the run for "nothing left behind".
      if (options.keepUnsaved) {
        kept.push({
          threadId: thread.id,
          worktreePath: thread.worktreePath,
          dirtyFileCount: 0,
          unpushedCommitCount: 0,
        });
      }
      continue;
    }
    if (removed.value) {
      kept.push({ threadId: thread.id, worktreePath: thread.worktreePath, ...removed.value });
      log.info('Kept a factory run worktree with unsaved work', {
        namespace: 'factory',
        threadId: thread.id,
        ...removed.value,
      });
      continue;
    }
    await clearThreadWorkspace(thread.id);
    browserEvents?.toUser(userId, {
      type: 'thread:updated',
      threadId: thread.id,
      data: { worktreePath: null, branch: null },
    });
    log.info('Removed a factory run worktree', {
      namespace: 'factory',
      threadId: thread.id,
      reason,
      branch: thread.branch,
    });
  }
  return kept;
}

/**
 * Archive the threads a retry replaced: the run no longer records them, and a
 * new agent thread with the same title takes their place. Left in the list,
 * the old failed thread looks like the run's (and deleting it looks like it
 * did nothing). A thread a member is still running is left alone.
 */
export async function archiveReplacedFactoryThreads(
  threadIds: string[],
  browserEvents?: BrowserEventsPort,
): Promise<void> {
  if (threadIds.length === 0) return;
  const rows = await db
    .select({ id: threads.id, userId: threads.userId })
    .from(threads)
    .where(
      and(
        inArray(threads.id, [...new Set(threadIds)]),
        eq(threads.archived, 0),
        notInArray(threads.status, ACTIVE_STATUSES),
      ),
    );
  if (rows.length === 0) return;
  await db
    .update(threads)
    .set({ archived: 1 })
    .where(
      inArray(
        threads.id,
        rows.map((row) => row.id),
      ),
    );
  for (const row of rows) {
    browserEvents?.toUser(row.userId, {
      type: 'thread:updated',
      threadId: row.id,
      data: { archived: 1 },
    });
  }
  log.info('Archived factory threads a retry replaced', {
    namespace: 'factory',
    threadIds: rows.map((row) => row.id),
  });
}

/** A worktree the cleanup left in place because removing it would lose work. */
export interface KeptWorktree {
  threadId: string;
  worktreePath: string;
  dirtyFileCount: number;
  unpushedCommitCount: number;
}

const removeUnchangedResponse = z.object({
  removed: z.boolean(),
  dirtyFileCount: z.number().optional(),
  unpushedCommitCount: z.number().optional(),
});

/**
 * Ask the thread's runner to remove its worktree unless work would be lost with
 * it (`POST /api/worktrees/remove-unchanged`). Answers the unsaved work the
 * runner kept the worktree for, or null when it removed it.
 */
async function removeUnchangedWorktree(
  ports: RunnerPorts,
  userId: string,
  thread: { id: string; projectId: string; worktreePath: string; branch: string | null },
): Promise<Result<UnsavedWork | null, string>> {
  const sent = await sendToThreadRunner(ports, userId, {
    method: 'POST',
    path: '/api/worktrees/remove-unchanged',
    query: { threadId: thread.id, projectId: thread.projectId },
    body: {
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
      branchName: thread.branch ?? undefined,
      deleteBranch: !!thread.branch,
      reason: 'factory-no-change',
      threadId: thread.id,
    },
  });
  return sent.map(unsavedWorkOf).mapErr((error) => error.message);
}

type UnsavedWork = { dirtyFileCount: number; unpushedCommitCount: number };

/**
 * The unsaved work a `remove-unchanged` answer reports, or null when the runner
 * removed the worktree. An answer that does not say `removed: true` is read as
 * kept: the thread must go on pointing at a worktree that may still exist.
 */
function unsavedWorkOf(body: string | null): UnsavedWork | null {
  const parsed = parseStoredJson(removeUnchangedResponse, body ?? '{}', 'remove-unchanged');
  if (parsed.ok && parsed.value.removed) return null;
  return {
    dirtyFileCount: parsed.ok ? (parsed.value.dirtyFileCount ?? 0) : 0,
    unpushedCommitCount: parsed.ok ? (parsed.value.unpushedCommitCount ?? 0) : 0,
  };
}

/** Stop a regression proof job on the thread's runner (best effort: a failure is logged). */
export async function cancelRegressionProofOnRunner(
  ports: RunnerPorts,
  userId: string,
  threadId: string,
  proofId: string,
): Promise<void> {
  const sink = authorizedRunnerRequests(ports.requests);
  const path = `/api/threads/${threadId}/regression-proof/${proofId}`;
  try {
    const sent = await withRunnerFor(
      runnerActor({ userId }),
      { kind: 'request', path, query: {} },
      ports.presence,
      (actor, runner, proof) =>
        sink.send(actor, runner, proof, { method: 'DELETE', path, headers: {}, body: null }),
    );
    if (sent.isErr() || (sent.value.status >= 400 && sent.value.status !== 404)) {
      log.warn('Issue factory could not stop a regression proof', {
        namespace: 'factory',
        threadId,
        proofId,
        error: sent.isErr() ? sent.error.reason : `runner answered ${sent.value.status}`,
      });
    }
  } catch (error) {
    log.warn('Issue factory could not stop a regression proof', {
      namespace: 'factory',
      threadId,
      proofId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
