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
import { resolveSDKCliPath } from '@funny/core/agents';

import { log } from '../../lib/logger.js';
import { metric, startSpan } from '../../lib/telemetry.js';
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
  newSessionId: string;
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
  const q = query({
    prompt: emptyPrompt(),
    options: {
      resume: sessionId,
      enableFileCheckpointing: true,
      cwd,
      pathToClaudeCodeExecutable: resolveSDKCliPath(),
      abortController: controller,
      executable: 'node',
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
  cwd: string;
  uuid: string;
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
  if (provider !== 'claude') {
    throw new ThreadServiceError('Rewind is only available for Claude threads', 400);
  }
  if (!(source as any).fileCheckpointingEnabled) {
    throw new ThreadServiceError(
      'This thread was started without file checkpointing. Rewind is unavailable.',
      400,
    );
  }
  if (!(source as any).sessionId) {
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
  const userMsgIndex =
    dbMessages.slice(0, anchorIdx + 1).filter((m) => m.role === 'user').length - 1;

  const { uuid } = await resolveSdkUserMessageUuid(
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
  );

  return {
    sourceThread: source as any,
    cwd,
    uuid,
    anchorIdx,
    anchorTimestamp: anchor.timestamp,
  };
}

// ── Public API ──────────────────────────────────────────────────────

export async function rewindCode(params: RewindCodeParams): Promise<RewindCodeResult> {
  const span = startSpan('thread.rewind_code', {
    attributes: { threadId: params.threadId },
  });
  try {
    const anchor = await resolveAnchor(params);
    const sourceSessionId = (anchor.sourceThread as any).sessionId as string;

    // 1. Restore files via a temp query.
    const rewindResult = await withResumedQueryForRewind<RewindFilesResult>(
      sourceSessionId,
      anchor.cwd,
      (q) => (q as any).rewindFiles(anchor.uuid) as Promise<RewindFilesResult>,
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

export async function forkAndRewind(params: ForkAndRewindParams): Promise<ForkAndRewindResult> {
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

    const newThread = await forkThread({
      sourceThreadId: params.sourceThreadId,
      messageId: params.messageId,
      userId: params.userId,
      title: params.title,
    });
    const newSessionId = (newThread as any).sessionId as string | null;
    const newCwd = (newThread as any).worktreePath ?? anchor.cwd;
    if (!newSessionId) {
      throw new ThreadServiceError('Forked thread has no session to rewind', 500);
    }

    const rewindResult = await withResumedQueryForRewind<RewindFilesResult>(
      newSessionId,
      newCwd,
      (q) => (q as any).rewindFiles(anchor.uuid) as Promise<RewindFilesResult>,
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
