/**
 * The `/api/threads` operations the server answers from its own DB (lists,
 * detail, messages, field updates), for both the REST routes in
 * routes/threads.ts and the `threads` tRPC router. Creation, fork and agent
 * operations are proxied to the runner and stay in routes/threads.ts.
 *
 * Built per request: writes broadcast to the caller's tabs through the
 * request's `browserEvents` sink.
 */

import { failure, type ThreadsPort } from '@funny/api';
import type { ThreadWithMessages } from '@funny/shared';
import type { ThreadPatchRequest } from '@funny/shared/contracts/threads';
import { ok, err } from 'neverthrow';

import { repos } from '../../db/repos.js';
import { log } from '../../lib/logger.js';
import { toMessage, toOptionalMessage } from '../../lib/message-response.js';
import { authorizer } from '../../lib/server-authorizer.js';
import { startSpan } from '../../lib/telemetry.js';
import { toThread, toThreadDetail } from '../../lib/thread-response.js';
import * as messageQueueRepo from '../../services/message-queue-repository.js';
import type { BrowserEventSink } from '../../services/runner-ports.js';

const stageHistoryRepo = repos.stageHistory();
const threadRepo = repos.threads();
const messageRepo = repos.messages();
const shareRepo = repos.threadShares();
const pendingPermissionRepo = repos.pendingPermissions();

const threadNotFound = () => err(failure(404, 'Thread not found'));

/**
 * Scratch filter is opt-in. When listing by project, exclude scratch threads
 * so they never leak into the project sidebar.
 */
function scratchFilter(onlyScratch: boolean, projectId: string | undefined) {
  if (onlyScratch) return true;
  return projectId ? ('exclude' as const) : undefined;
}

function childSpan(parent: ReturnType<typeof startSpan>, name: string, threadId: string) {
  return startSpan(name, {
    traceId: parent.traceId,
    parentSpanId: parent.spanId,
    attributes: { 'thread.id': threadId },
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function detailSpanAttributes(
  id: string,
  query: { messageLimit?: number; messageProgress?: number; messageAnchorId?: string },
) {
  return {
    'thread.id': id,
    'thread.message_limit': query.messageLimit ?? null,
    'thread.message_progress': query.messageProgress ?? null,
    'thread.message_anchor_id': query.messageAnchorId ?? null,
  };
}

/**
 * The live approval request, if any, and the approval capability. Only an
 * active durable request can prove an ACP continuation still exists after a
 * reload. In every other Codex state we conservatively expose the SDK-style
 * unavailable capability so the client never reconstructs a fake approval
 * card from historic tool output.
 */
function permissionFields(
  provider: string,
  pending: ThreadWithMessages['pendingPermissionRequest'] | null | undefined,
): Pick<ThreadWithMessages, 'pendingPermissionRequest' | 'permissionApprovalCapability'> {
  const request = pending ? { pendingPermissionRequest: pending } : {};
  if (provider !== 'codex') return request;
  return {
    ...request,
    permissionApprovalCapability: pending
      ? { kind: 'structured', transport: 'codex-acp' }
      : { kind: 'unavailable', reason: 'codex-sdk-no-interactive-approval' },
  };
}

/**
 * The column writes for a PATCH body. Security CR-4: `worktreePath` is not in
 * the contract's body schema (see `threadPatchBody`), so it never gets here.
 */
function threadPatchUpdates(body: ThreadPatchRequest): Record<string, unknown> {
  const { archived, pinned, schedulerManaged, ...fields } = body;
  const updates: Record<string, unknown> = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  // The flag columns are integers.
  const flags = { archived, pinned, schedulerManaged };
  for (const [column, value] of Object.entries(flags)) {
    if (value !== undefined) updates[column] = value ? 1 : 0;
  }
  return updates;
}

type StageMove = { from: string | null; to: string };
type StagedThread = { stage?: string | null; archived?: unknown };

/** Archiving moves to `archived`; unarchiving moves back to the requested (or current) stage. */
function archiveMove(thread: StagedThread, body: ThreadPatchRequest): StageMove | undefined {
  if (body.archived === undefined || body.archived === !!thread.archived) return undefined;
  return body.archived
    ? { from: thread.stage ?? null, to: 'archived' }
    : { from: 'archived', to: body.stage ?? thread.stage ?? 'backlog' };
}

/** The stage move a PATCH makes, if any. */
function stageTransition(thread: StagedThread, body: ThreadPatchRequest): StageMove | null {
  const move =
    archiveMove(thread, body) ??
    (body.stage === undefined ? undefined : { from: thread.stage ?? null, to: body.stage });
  return move && move.to !== move.from ? move : null;
}

/** The thread as it is now, after a write; 404 if it was deleted meanwhile. */
async function currentThread(id: string) {
  const updated = await threadRepo.getThread(id);
  return updated ? ok(toThread(updated)) : threadNotFound();
}

export function createThreadsPort(browserEvents: BrowserEventSink | undefined): ThreadsPort {
  return {
    async list({ userId, organizationId }, query) {
      const { projectId, designId, includeArchived, limit, offset } = query;

      // Span on the native list path (mirrors get). Its start_time_ms reveals
      // WHEN the server began handling each sidebar list during app refresh — if the
      // ~28 per-project lists start spread across the load window the bottleneck is
      // upstream (browser per-origin socket queue / proxy); if they start clustered
      // but the span durations stack, it's server-side DB serialization.
      const span = startSpan('GET /api/threads', {
        attributes: {
          'thread.project_id': projectId ?? null,
          'thread.limit': limit,
          'thread.offset': offset,
        },
      });
      try {
        const { threads, total } = await threadRepo.listThreads({
          projectId: projectId || undefined,
          designId: designId || undefined,
          userId,
          includeArchived,
          organizationId,
          isScratch: scratchFilter(query.isScratch, projectId),
          limit,
          offset,
        });

        span.attributes['thread.count'] = threads.length;
        span.attributes['thread.total'] = Number(total);
        span.end('ok');
        return ok({
          threads: threads.map(toThread),
          total,
          hasMore: offset + threads.length < total,
        });
      } catch (e) {
        span.end('error', errorText(e));
        throw e;
      }
    },

    async scratch(userId, { limit, offset }) {
      const { threads, total } = await threadRepo.listThreads({
        userId,
        isScratch: true,
        includeArchived: false,
        limit,
        offset,
      });
      return ok({
        threads: threads.map(toThread),
        total,
        hasMore: offset + threads.length < total,
      });
    },

    async archived(userId, query) {
      const { page, limit } = query;
      const search = query.search?.trim() || '';
      const projectId = query.projectId?.trim() || undefined;
      const result = await threadRepo.listArchivedThreads({
        page,
        limit,
        search,
        userId,
        projectId,
      });
      return ok({ threads: result.threads.map(toThread), total: result.total, page, limit });
    },

    async get(userId, id, query) {
      const { messageLimit, messageProgress, messageAnchorId } = query;
      const span = startSpan('GET /api/threads/:id', {
        attributes: detailSpanAttributes(id, query),
      });
      try {
        // Fetch thread+messages, queue count, and queue head in parallel.
        // Ownership is checked off the thread row inside the same query result,
        // so we avoid a separate getThread() round-trip.
        const fetchSpan = childSpan(span, 'thread.fetch_with_messages', id);
        const queueCountSpan = childSpan(span, 'thread.queue_count', id);
        const queuePeekSpan = childSpan(span, 'thread.queue_peek', id);
        const [result, queuedCount, queuedNext, pendingPermissionRequest] = await Promise.all([
          messageRepo
            .getThreadWithMessages(id, messageLimit, { messageProgress, messageAnchorId })
            .finally(() => fetchSpan.end('ok')),
          messageQueueRepo.queueCount(id).finally(() => queueCountSpan.end('ok')),
          messageQueueRepo.peek(id).finally(() => queuePeekSpan.end('ok')),
          pendingPermissionRepo.getActive(id),
        ]);

        if (!result || !(await authorizer.authorize(userId, 'thread', result.id, 'view'))) {
          span.end('ok');
          return threadNotFound();
        }

        // Expose the VIEWER's own grant level so the client can gate level-specific
        // affordances (comment box, PromptInput, git read panel). The owner gets
        // `null` (not a sharee); a sharee gets 'view' | 'comment' | 'steer'.
        const viewerShareLevel =
          result.userId === userId ? null : await shareRepo.getShareLevel(id, userId);

        span.attributes['thread.message_count'] = result.messages?.length ?? 0;
        span.attributes['thread.queued_count'] = queuedCount;
        span.end('ok');
        return ok({
          ...toThreadDetail(result),
          queuedCount,
          queuedNextMessage: queuedNext?.content,
          ...permissionFields(result.provider, pendingPermissionRequest),
          viewerShareLevel,
        });
      } catch (e) {
        span.end('error', errorText(e));
        throw e;
      }
    },

    async messages(threadId, query) {
      const result = await messageRepo.getThreadMessages({
        threadId,
        cursor: query.cursor || undefined,
        limit: query.limit,
        direction: query.direction,
      });
      return ok({
        ...result,
        messages: result.messages.map(toMessage),
        leadingUserMessage: toOptionalMessage(result.leadingUserMessage),
      });
    },

    async searchMessages(threadId, query) {
      const q = query.q?.trim() ?? '';
      if (!q) return ok({ results: [] });
      const results = await messageRepo.searchMessages({
        threadId,
        query: q,
        limit: query.limit,
        caseSensitive: query.caseSensitive,
      });
      return ok({ results });
    },

    async searchContent(userId, query) {
      const q = query.q ?? '';
      const { projectId, caseSensitive } = query;
      if (!q.trim()) return ok({ threadIds: [], snippets: {} });

      const { searchThreadIdsByContent } = await import('../../services/search-repository.js');
      const results = await searchThreadIdsByContent({
        query: q,
        projectId,
        userId,
        caseSensitive,
      });
      const threadIds = Array.from(results.keys());
      const snippets: Record<string, string> = {};
      for (const [id, snippet] of results) snippets[id] = snippet;
      return ok({ threadIds, snippets });
    },

    async update(userId, thread, data) {
      const id = thread.id;
      const updates = threadPatchUpdates(data);
      if (Object.keys(updates).length > 0) {
        await threadRepo.updateThread(id, updates);
      }

      // Kanban drag moves and archive/unarchive both flow through here.
      // Record the stage transition (movement trail / analytics) and broadcast a
      // thread:stage-changed event so every tab's board updates live — the same
      // contract setStage (used by pipelines) already honors.
      const transition = stageTransition(thread, data);
      if (transition) {
        const { from, to } = transition;
        await stageHistoryRepo.recordStageChange(id, from, to);
        browserEvents?.toUser(userId, {
          type: 'thread:stage-changed',
          threadId: id,
          data: { fromStage: from, toStage: to, projectId: thread.projectId },
        });
        log.info('Thread stage transition recorded via PATCH', {
          namespace: 'threads',
          threadId: id,
          fromStage: from,
          toStage: to,
        });
      }
      return currentThread(id);
    },

    // Persist the composer selection independently of sending a prompt. A
    // currently-running agent keeps the policy with which it started; this value
    // applies when it next starts or resumes.
    async setPermissionMode(userId, threadId, permissionMode) {
      await threadRepo.updateThread(threadId, { permissionMode });
      browserEvents?.toUser(userId, {
        type: 'thread:updated',
        threadId,
        data: { permissionMode },
      });
      return currentThread(threadId);
    },

    // `set_status` / `set_stage` actions of the YAML pipeline DSL: strict enum
    // validation and a single emission point for the event the kanban listens on.
    async setStatus(userId, threadId, status, reason) {
      await threadRepo.updateThread(threadId, { status });
      browserEvents?.toUser(userId, {
        type: 'thread:updated',
        threadId,
        data: { status, reason },
      });
      log.info('Thread status patched', { namespace: 'threads', threadId, status, reason });
      return currentThread(threadId);
    },

    async setStage(userId, thread, toStage, reason) {
      const id = thread.id;
      const fromStage = thread.stage;
      await threadRepo.updateThread(id, { stage: toStage });
      if (toStage !== fromStage) {
        await stageHistoryRepo.recordStageChange(id, fromStage ?? null, toStage);
        browserEvents?.toUser(userId, {
          type: 'thread:stage-changed',
          threadId: id,
          data: { fromStage, toStage, projectId: thread.projectId, reason },
        });
      }
      log.info('Thread stage patched', {
        namespace: 'threads',
        threadId: id,
        fromStage,
        toStage,
        reason,
      });
      return currentThread(id);
    },
  };
}
