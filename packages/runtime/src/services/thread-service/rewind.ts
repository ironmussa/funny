/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: (none — uses tm.updateThread which broadcasts via WS broker)
 *
 * Rewind a thread back to a specific user message, natively in funny for
 * every provider:
 *   1. Restore the Git checkpoint captured right before that user message
 *      (`git-checkpoints.ts`, taken by the agent lifecycle before each turn).
 *   2. Truncate the DB messages strictly after the anchor.
 *   3. Drop the provider session: no SDK can resume at an earlier turn from
 *      outside its own storage, so the next follow-up starts a fresh session
 *      seeded with the truncated transcript (`contextRecoveryReason: 'rewound'`).
 *
 * The thread MUST be idle — a running agent owns the worktree. Callers are
 * responsible for stopping the agent first.
 *
 * Two operations:
 *   - `rewindCode()` — rewind in place on the source thread
 *   - `forkAndRewind()` — fork the conversation first, then restore the
 *     checkpoint for the fork. The source thread's transcript is left
 *     untouched; its files are shared with the fork (same worktree).
 */

import { badRequest, internal } from '@funny/shared/errors';
import { err, ok, ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { metric, startSpan } from '../../lib/telemetry.js';
import { restoreGitCheckpoint, type GitCheckpointRestoreResult } from '../git-checkpoints.js';
import { rewindTracked } from '../git-destructive.js';
import { getServices } from '../service-registry.js';
import { canDoGitOps } from '../thread-context.js';
import * as tm from '../thread-manager.js';
import { forkThread } from './fork.js';
import { ThreadServiceError } from './helpers.js';

export interface RewindCodeParams {
  threadId: string;
  messageId: string;
  userId: string;
}

export interface RewindCodeResult {
  threadId: string;
  /** Always null: rewinding drops the provider session (see module doc). */
  newSessionId: null;
  rewind: GitCheckpointRestoreResult;
  deletedMessageCount: number;
}

export interface ForkAndRewindParams {
  sourceThreadId: string;
  messageId: string;
  userId: string;
  title?: string;
}

export interface ForkAndRewindResult {
  thread: Record<string, any>;
  rewind: GitCheckpointRestoreResult;
}

// ── Shared validation ───────────────────────────────────────────────

interface ResolvedAnchor {
  sourceThread: Record<string, any>;
  provider: string;
  cwd: string;
  anchorIdx: number;
  anchorTimestamp: string;
}

async function resolveAnchor(params: {
  threadId: string;
  messageId: string;
  userId: string;
}): Promise<ResolvedAnchor> {
  const source = await tm.getThread(params.threadId);
  if (!source || source.userId !== params.userId) {
    throw new ThreadServiceError('Thread not found', 404);
  }
  const provider = source.provider ?? 'claude';
  if (!canDoGitOps(source)) {
    throw new ThreadServiceError('Rewind is unavailable for scratch threads', 400);
  }
  if (!source.fileCheckpointingEnabled) {
    throw new ThreadServiceError(
      'This thread was started without file checkpointing. Rewind is unavailable.',
      400,
    );
  }
  if (source.status === 'running') {
    throw new ThreadServiceError('Stop the agent before rewinding', 409);
  }

  const projectPath = await getServices()
    .projects.resolveProjectPath(source.projectId, params.userId)
    .then((r) => {
      if (r.isErr()) throw new ThreadServiceError(r.error.message, 400);
      return r.value;
    });
  const cwd = source.worktreePath ?? projectPath;

  const detail = await tm.getThreadWithMessages(params.threadId);
  const dbMessages: any[] = detail?.messages ?? [];
  const anchorIdx = dbMessages.findIndex((m) => m.id === params.messageId);
  if (anchorIdx < 0) throw new ThreadServiceError('Message not found in thread', 404);
  const anchor = dbMessages[anchorIdx];
  if (anchor.role !== 'user') {
    throw new ThreadServiceError('Can only rewind to a user message', 400);
  }

  return {
    sourceThread: source,
    provider,
    cwd,
    anchorIdx,
    anchorTimestamp: anchor.timestamp,
  };
}

/**
 * Restore the checkpoint captured for `messageId`, or throw a 400 when there
 * is none. The files it replaces are saved first as an undo snapshot and the
 * rewind is recorded as a `git.destructive` activity
 * (track-user-and-scheduled-actions, design D5).
 */
async function restoreCheckpointOrThrow(params: {
  /** The checkpoint's thread (the source thread, for a fork). */
  threadId: string;
  messageId: string;
  cwd: string;
  /** Who rewinds, and the thread the activity concerns. */
  userId: string;
  activityThreadId: string;
  projectId: string | null;
}): Promise<GitCheckpointRestoreResult> {
  const { threadId, messageId, cwd } = params;
  const result = await rewindTracked(
    { userId: params.userId, cwd, threadId: params.activityThreadId, projectId: params.projectId },
    messageId,
    () =>
      ResultAsync.fromPromise(restoreGitCheckpoint({ threadId, messageId, cwd }), (e) =>
        internal(String(e)),
      ).andThen((restored) =>
        restored.canRewind
          ? ok(restored)
          : err(badRequest(restored.error ?? 'No Git checkpoint available')),
      ),
  );
  if (result.isErr()) {
    throw new ThreadServiceError(
      result.error.message,
      result.error.type === 'INTERNAL' ? 500 : 400,
    );
  }
  return result.value;
}

// ── Public API ──────────────────────────────────────────────────────

export function rewindCode(
  params: RewindCodeParams,
): ResultAsync<RewindCodeResult, ThreadServiceError> {
  return ResultAsync.fromPromise(rewindCodeImpl(params), (err) =>
    err instanceof ThreadServiceError ? err : new ThreadServiceError(String(err), 500),
  );
}

async function rewindCodeImpl(params: RewindCodeParams): Promise<RewindCodeResult> {
  const span = startSpan('thread.rewind_code', {
    attributes: { threadId: params.threadId },
  });
  try {
    const anchor = await resolveAnchor(params);

    // 1. Restore files from the checkpoint taken before the anchor turn.
    const rewindResult = await restoreCheckpointOrThrow({
      threadId: params.threadId,
      messageId: params.messageId,
      cwd: anchor.cwd,
      userId: params.userId,
      activityThreadId: params.threadId,
      projectId: anchor.sourceThread.projectId || null,
    });

    // 2. Truncate the DB transcript and drop the provider session. The next
    //    follow-up starts a fresh session seeded with the truncated transcript.
    const deletedMessageCount = await tm.deleteMessagesAfter(params.threadId, params.messageId);
    await tm.updateThread(params.threadId, {
      sessionId: null,
      contextRecoveryReason: 'rewound',
      fileCheckpointingEnabled: 1,
      status: 'idle',
    });

    log.info('Thread rewound from Git checkpoint', {
      namespace: 'thread-rewind',
      threadId: params.threadId,
      provider: anchor.provider,
      filesChanged: rewindResult.filesChanged.length,
      deletedMessageCount,
    });
    metric('threads.rewound', 1, { type: 'sum' });
    span.end('ok');
    return {
      threadId: params.threadId,
      newSessionId: null,
      rewind: rewindResult,
      deletedMessageCount,
    };
  } catch (err) {
    // SAFETY: span-status read only; `?.` keeps a non-Error throw from throwing
    // again here, and one without `message` is recorded as 'unknown'.
    span.end('error', (err as Error)?.message ?? 'unknown');
    throw err;
  }
}

export function forkAndRewind(
  params: ForkAndRewindParams,
): ResultAsync<ForkAndRewindResult, ThreadServiceError> {
  return ResultAsync.fromPromise(forkAndRewindImpl(params), (err) =>
    err instanceof ThreadServiceError ? err : new ThreadServiceError(String(err), 500),
  );
}

async function forkAndRewindImpl(params: ForkAndRewindParams): Promise<ForkAndRewindResult> {
  const span = startSpan('thread.fork_and_rewind', {
    attributes: { threadId: params.sourceThreadId },
  });
  try {
    // Validate up front so we don't fork only to bail on rewind. The fork
    // will revalidate a few of these but the early check gives a cleaner
    // error path.
    const anchor = await resolveAnchor({
      threadId: params.sourceThreadId,
      messageId: params.messageId,
      userId: params.userId,
    });

    const forkResult = await forkThread({
      sourceThreadId: params.sourceThreadId,
      messageId: params.messageId,
      userId: params.userId,
      title: params.title,
    });
    if (forkResult.isErr()) throw forkResult.error;
    const newThread = forkResult.value;
    const newCwd = newThread.worktreePath ?? anchor.cwd;

    // The fork re-points the source's checkpoint refs at its copied messages,
    // but the trees are identical, so restore from the source's checkpoint:
    // it is the one `resolveAnchor` validated and it exists even if copying
    // was skipped.
    const rewindResult = await restoreCheckpointOrThrow({
      threadId: params.sourceThreadId,
      messageId: params.messageId,
      cwd: newCwd,
      userId: params.userId,
      activityThreadId: newThread.id,
      projectId: anchor.sourceThread.projectId || null,
    });

    log.info('Thread forked and code rewound', {
      namespace: 'thread-rewind',
      sourceThreadId: params.sourceThreadId,
      newThreadId: newThread.id,
      provider: anchor.provider,
      filesChanged: rewindResult.filesChanged.length,
    });
    metric('threads.fork_rewound', 1, { type: 'sum' });
    span.end('ok');

    return { thread: newThread, rewind: rewindResult };
  } catch (err) {
    // SAFETY: span-status read only; `?.` keeps a non-Error throw from throwing
    // again here, and one without `message` is recorded as 'unknown'.
    span.end('error', (err as Error)?.message ?? 'unknown');
    throw err;
  }
}
