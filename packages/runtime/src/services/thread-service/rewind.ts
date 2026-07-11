/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: (none — uses tm.updateThread which broadcasts via WS broker)
 *
 * Rewind a thread back to a specific user message:
 *   1. Resolve the SDK transcript UUID for the target DB message.
 *   2. Open a temporary `query({ resume })` and call `rewindFiles(uuid)`
 *      to restore on-disk files to their state right before that turn.
 *   3. Slice the transcript via `forkSession({ upToMessageId })` and adopt
 *      the new session as the thread's active session.
 *   4. Truncate the DB messages strictly after the anchor.
 *
 * The thread MUST be idle — a running runner owns the SDK process, so
 * spawning another with the same `resume` would race over the session
 * file. Callers are responsible for stopping the agent first.
 *
 * Two operations:
 *   - `rewindCode()` — rewind in place on the source thread
 *   - `forkAndRewind()` — fork the conversation first, then rewind the
 *     fork. The source thread is left untouched.
 */

import { forkSession, query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, RewindFilesResult } from '@anthropic-ai/claude-agent-sdk';
import { resolveSDKCli } from '@funny/core/agents';
import { ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { metric, startSpan } from '../../lib/telemetry.js';
import { restoreCodexCheckpoint } from '../codex-git-checkpoints.js';
import { getServices } from '../service-registry.js';
import * as tm from '../thread-manager.js';
import { forkThread } from './fork.js';
import { ThreadServiceError } from './helpers.js';
import { resolveSdkUserMessageUuid } from './sdk-session.js';

export interface RewindCodeParams {
  threadId: string;
  messageId: string;
  userId: string;
}

export interface RewindCodeResult {
  threadId: string;
  newSessionId: string | null;
  rewind: RewindFilesResult;
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
  rewind: RewindFilesResult;
}

// ── Temp query helper ───────────────────────────────────────────────

/**
 * Spawn a short-lived SDK Query against an existing session purely to
 * invoke `rewindFiles()`. The CLI is started with a never-yielding
 * prompt so it doesn't burn a model turn, then aborted.
 */
async function withResumedQueryForRewind<T>(
  sessionId: string,
  cwd: string,
  fn: (q: Query) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  async function* emptyPrompt(): AsyncGenerator<any, void, unknown> {
    // Never yield. The CLI control channel still comes up, but no turn runs.
  }
  const cli = resolveSDKCli();
  const q = query({
    prompt: emptyPrompt(),
    options: {
      resume: sessionId,
      enableFileCheckpointing: true,
      cwd,
      pathToClaudeCodeExecutable: cli.path,
      abortController: controller,
      ...(cli.kind === 'js' ? { executable: 'node' as const } : {}),
      maxTurns: 0,
    } as any,
  });
  try {
    return await fn(q);
  } finally {
    try {
      (q as any).close?.();
    } catch (err) {
      log.warn('rewind: query.close() threw', {
        namespace: 'thread-rewind',
        error: (err as Error)?.message,
      });
    }
    controller.abort();
  }
}

// ── Shared validation ───────────────────────────────────────────────

interface ResolvedAnchor {
  sourceThread: Record<string, any>;
  provider: string;
  cwd: string;
  uuid?: string;
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
  const provider = (source as any).provider ?? 'claude';
  if (provider !== 'claude' && provider !== 'codex') {
    throw new ThreadServiceError('Rewind is only available for Claude and Codex threads', 400);
  }
  if (!(source as any).fileCheckpointingEnabled) {
    throw new ThreadServiceError(
      'This thread was started without file checkpointing. Rewind is unavailable.',
      400,
    );
  }
  if (provider === 'claude' && !(source as any).sessionId) {
    throw new ThreadServiceError('Thread has no session to rewind', 400);
  }
  if ((source as any).status === 'running') {
    throw new ThreadServiceError('Stop the agent before rewinding', 409);
  }

  const projectPath = await getServices()
    .projects.resolveProjectPath((source as any).projectId, params.userId)
    .then((r) => {
      if (r.isErr()) throw new ThreadServiceError(r.error.message, 400);
      return r.value;
    });
  const cwd = (source as any).worktreePath ?? projectPath;

  const detail = await tm.getThreadWithMessages(params.threadId);
  const dbMessages: any[] = detail?.messages ?? [];
  const anchorIdx = dbMessages.findIndex((m) => m.id === params.messageId);
  if (anchorIdx < 0) throw new ThreadServiceError('Message not found in thread', 404);
  const anchor = dbMessages[anchorIdx];
  if (anchor.role !== 'user') {
    throw new ThreadServiceError('Can only rewind to a user message', 400);
  }
  let uuid: string | undefined;
  if (provider === 'claude') {
    const userMsgIndex =
      dbMessages.slice(0, anchorIdx + 1).filter((m) => m.role === 'user').length - 1;
    uuid = (
      await resolveSdkUserMessageUuid(
        { sessionId: (source as any).sessionId, cwd, userMsgIndex },
        (code, detail) => {
          log.error('rewind: failed to resolve SDK uuid', {
            namespace: 'thread-rewind',
            threadId: source.id,
            sessionId: (source as any).sessionId,
            code,
            detail,
          });
          throw new ThreadServiceError(
            code === 'transcript_read_failed'
              ? 'Failed to read agent session transcript'
              : 'Could not locate matching message in agent session transcript',
            500,
          );
        },
      )
    ).uuid;
  }

  return {
    sourceThread: source as any,
    provider,
    cwd,
    uuid,
    anchorIdx,
    anchorTimestamp: anchor.timestamp,
  };
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
    if (anchor.provider === 'codex') {
      const rewindResult = await restoreCodexCheckpoint({
        threadId: params.threadId,
        messageId: params.messageId,
        cwd: anchor.cwd,
      });
      if (!rewindResult.canRewind) {
        span.end('error', rewindResult.error ?? 'cannot_rewind');
        throw new ThreadServiceError(rewindResult.error ?? 'No Git checkpoint available', 400);
      }

      const deletedMessageCount = await tm.deleteMessagesAfter(params.threadId, params.messageId);
      // Codex cannot fork/resume a session at an earlier turn. The next
      // follow-up starts a fresh session with the truncated DB transcript.
      await tm.updateThread(params.threadId, {
        sessionId: null,
        contextRecoveryReason: 'rewound',
        fileCheckpointingEnabled: 1,
        status: 'idle',
      });

      log.info('Codex thread rewound from Git checkpoint', {
        namespace: 'thread-rewind',
        threadId: params.threadId,
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
    }
    const sourceSessionId = (anchor.sourceThread as any).sessionId as string;

    // 1. Restore files via a temp query.
    const rewindResult = await withResumedQueryForRewind<RewindFilesResult>(
      sourceSessionId,
      anchor.cwd,
      (q) => (q as any).rewindFiles(anchor.uuid!) as Promise<RewindFilesResult>,
    );
    if (!rewindResult.canRewind) {
      span.end('error', rewindResult.error ?? 'cannot_rewind');
      throw new ThreadServiceError(
        rewindResult.error ?? 'No checkpoint available for this message',
        400,
      );
    }

    // 2. Slice the SDK transcript at the anchor; adopt the new session.
    const fork = await forkSession(sourceSessionId, {
      upToMessageId: anchor.uuid,
      dir: anchor.cwd,
    });

    // 3. Truncate DB transcript and update thread.
    const deletedMessageCount = await tm.deleteMessagesAfter(params.threadId, params.messageId);
    await tm.updateThread(params.threadId, {
      sessionId: fork.sessionId,
      // Forks lose checkpoint history — re-enable for the new session so
      // future edits are tracked again.
      fileCheckpointingEnabled: 1,
      status: 'idle',
    });

    log.info('Thread code rewound', {
      namespace: 'thread-rewind',
      threadId: params.threadId,
      newSessionId: fork.sessionId,
      filesChanged: rewindResult.filesChanged?.length ?? 0,
      deletedMessageCount,
    });
    metric('threads.rewound', 1, { type: 'sum' });
    span.end('ok');

    return {
      threadId: params.threadId,
      newSessionId: fork.sessionId,
      rewind: rewindResult,
      deletedMessageCount,
    };
  } catch (err) {
    if (!(err instanceof ThreadServiceError)) {
      span.end('error', (err as Error)?.message ?? 'unknown');
    }
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
    if (anchor.provider !== 'claude') {
      throw new ThreadServiceError(
        'Fork and rewind is not available for Codex because a fork shares the current worktree.',
        400,
      );
    }

    const forkResult = await forkThread({
      sourceThreadId: params.sourceThreadId,
      messageId: params.messageId,
      userId: params.userId,
      title: params.title,
    });
    if (forkResult.isErr()) throw forkResult.error;
    const newThread = forkResult.value;
    const newSessionId = (newThread as any).sessionId as string | null;
    const newCwd = (newThread as any).worktreePath ?? anchor.cwd;
    if (!newSessionId) {
      throw new ThreadServiceError('Forked thread has no session to rewind', 500);
    }

    const rewindResult = await withResumedQueryForRewind<RewindFilesResult>(
      newSessionId,
      newCwd,
      (q) => (q as any).rewindFiles(anchor.uuid!) as Promise<RewindFilesResult>,
    );
    if (!rewindResult.canRewind) {
      log.warn('fork_and_rewind: rewindFiles returned canRewind=false', {
        namespace: 'thread-rewind',
        forkedThreadId: (newThread as any).id,
        error: rewindResult.error,
      });
    }

    log.info('Thread forked and code rewound', {
      namespace: 'thread-rewind',
      sourceThreadId: params.sourceThreadId,
      newThreadId: (newThread as any).id,
      filesChanged: rewindResult.filesChanged?.length ?? 0,
    });
    metric('threads.fork_rewound', 1, { type: 'sum' });
    span.end('ok');

    return { thread: newThread, rewind: rewindResult };
  } catch (err) {
    if (!(err instanceof ThreadServiceError)) {
      span.end('error', (err as Error)?.message ?? 'unknown');
    }
    throw err;
  }
}
