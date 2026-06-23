/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 *
 * Handles data persistence messages from runners.
 * When a runner sends data:insert_message, data:insert_tool_call, etc.,
 * this handler persists the data to the central server's DB and sends
 * back the response (with generated IDs for inserts).
 */

import {
  createMessageRepository,
  createToolCallRepository,
  createThreadRepository,
  createCommentRepository,
  createStageHistoryRepository,
  createWatcherRepository,
  createJobRepository,
} from '@funny/shared/repositories';
import { and, eq } from 'drizzle-orm';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import * as messageQueueRepo from './message-queue-repository.js';
import * as projectRepo from './project-repository.js';
import * as startupCommandsRepo from './startup-commands-repository.js';

// Create shared repository instances (lazy-initialized)
let _messageRepo: ReturnType<typeof createMessageRepository> | null = null;
let _toolCallRepo: ReturnType<typeof createToolCallRepository> | null = null;
let _threadRepo: ReturnType<typeof createThreadRepository> | null = null;
let _watcherRepo: ReturnType<typeof createWatcherRepository> | null = null;
let _jobRepo: ReturnType<typeof createJobRepository> | null = null;

function getWatcherRepo() {
  if (!_watcherRepo) {
    _watcherRepo = createWatcherRepository({
      db,
      schema: schema as any,
      dbAll,
      dbGet,
      dbRun,
    });
  }
  return _watcherRepo;
}

function getJobRepo() {
  if (!_jobRepo) {
    _jobRepo = createJobRepository({
      db,
      schema: schema as any,
      dbAll,
      dbGet,
      dbRun,
    });
  }
  return _jobRepo;
}

function getMessageRepo() {
  if (!_messageRepo) {
    _messageRepo = createMessageRepository({
      db,
      schema: schema as any,
      dbAll,
      dbGet,
      dbRun,
    });
  }
  return _messageRepo;
}

function getToolCallRepo() {
  if (!_toolCallRepo) {
    _toolCallRepo = createToolCallRepository({
      db,
      schema: schema as any,
      dbAll,
      dbGet,
      dbRun,
    });
  }
  return _toolCallRepo;
}

function getThreadRepo() {
  if (!_threadRepo) {
    const stageHistoryRepo = createStageHistoryRepository({
      db,
      schema: schema as any,
      dbRun,
    });
    const commentRepo = createCommentRepository({
      db,
      schema: schema as any,
      dbAll,
      dbRun,
    });
    _threadRepo = createThreadRepository({
      db,
      schema: schema as any,
      dbAll,
      dbGet,
      dbRun,
      commentRepo,
      stageHistoryRepo,
    });
  }
  return _threadRepo;
}

/**
 * Verify that the runner owning `runnerUserId` is allowed to touch the
 * user/thread/project/message/tool-call referenced by `data`.
 *
 * This is the tenant-isolation boundary for the data plane: without it, any
 * compromised or misconfigured runner can read another user's GitHub token,
 * delete someone else's thread, etc. (see SECURITY_AUDIT C3). Checks short-
 * circuit on the first mismatch.
 */
async function assertDataOwnership(
  runnerUserId: string | null,
  data: any,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const payload = data?.payload ?? {};

  // Types that do not reference any user-scoped entity. Runners without an
  // owning user (legacy rows where runners.user_id is NULL) can still access
  // these — everything else requires a known owner.
  const USER_NEUTRAL_TYPES = new Set<string>([
    'data:get_agent_template',
    'data:mark_and_list_stale_threads',
  ]);
  if (USER_NEUTRAL_TYPES.has(data?.type)) return { ok: true };

  if (!runnerUserId) {
    return { ok: false, reason: 'runner has no owning user' };
  }

  // ── Explicit userId on the request ─────────────────────────────
  const candidateUserId =
    typeof data?.userId === 'string' && data.userId
      ? data.userId
      : data?.type === 'data:create_thread' && typeof payload?.userId === 'string'
        ? payload.userId
        : undefined;
  if (candidateUserId && candidateUserId !== runnerUserId) {
    return {
      ok: false,
      reason: `userId ${candidateUserId} !== runner ${runnerUserId}`,
    };
  }

  // ── Thread ownership ───────────────────────────────────────────
  const threadId =
    (typeof data?.threadId === 'string' && data.threadId) ||
    (typeof payload?.threadId === 'string' && payload.threadId) ||
    undefined;
  if (threadId) {
    const row = (await dbGet(
      db
        .select({ userId: schema.threads.userId })
        .from(schema.threads)
        .where(eq(schema.threads.id, threadId)),
    )) as { userId: string } | undefined;
    if (!row) return { ok: false, reason: `thread ${threadId} not found` };
    if (row.userId !== runnerUserId) {
      return { ok: false, reason: `thread ${threadId} owned by ${row.userId}` };
    }
  }

  if (
    data?.type === 'data:get_thread_by_external_request_id' &&
    typeof data?.externalRequestId === 'string'
  ) {
    const row = (await dbGet(
      db
        .select({ userId: schema.threads.userId })
        .from(schema.threads)
        .where(eq(schema.threads.externalRequestId, data.externalRequestId)),
    )) as { userId: string } | undefined;
    if (row && row.userId !== runnerUserId) {
      return {
        ok: false,
        reason: `external request ${data.externalRequestId} owned by ${row.userId}`,
      };
    }
  }

  if (data?.type === 'data:get_thread_by_session_id' && typeof data?.sessionId === 'string') {
    const row = (await dbGet(
      db
        .select({ userId: schema.threads.userId })
        .from(schema.threads)
        .where(eq(schema.threads.sessionId, data.sessionId)),
    )) as { userId: string } | undefined;
    if (row && row.userId !== runnerUserId) {
      return {
        ok: false,
        reason: `session ${data.sessionId} owned by ${row.userId}`,
      };
    }
  }

  // ── Project ownership ──────────────────────────────────────────
  const projectId =
    (typeof data?.projectId === 'string' && data.projectId) ||
    (typeof payload?.projectId === 'string' && payload.projectId) ||
    undefined;
  if (projectId) {
    const p = await projectRepo.getProject(projectId);
    if (!p) return { ok: false, reason: `project ${projectId} not found` };
    if (p.userId !== runnerUserId) {
      // Allow if the runner's user is a member (per project_members).
      const member = (await dbGet(
        db
          .select({ userId: schema.projectMembers.userId })
          .from(schema.projectMembers)
          .where(
            and(
              eq(schema.projectMembers.projectId, projectId),
              eq(schema.projectMembers.userId, runnerUserId),
            ),
          ),
      )) as { userId: string } | undefined;
      if (!member) {
        return {
          ok: false,
          reason: `project ${projectId} owned by ${p.userId}`,
        };
      }
    }
  }

  // ── Message ownership (message → thread → user) ────────────────
  const messageIdForToolCall =
    typeof payload?.messageId === 'string' ? payload.messageId : undefined;
  if (data?.type === 'data:find_tool_call' && messageIdForToolCall) {
    const m = (await dbGet(
      db
        .select({ threadId: schema.messages.threadId })
        .from(schema.messages)
        .where(eq(schema.messages.id, messageIdForToolCall)),
    )) as { threadId: string } | undefined;
    if (m) {
      const t = (await dbGet(
        db
          .select({ userId: schema.threads.userId })
          .from(schema.threads)
          .where(eq(schema.threads.id, m.threadId)),
      )) as { userId: string } | undefined;
      if (!t || t.userId !== runnerUserId) {
        return {
          ok: false,
          reason: `message ${messageIdForToolCall} cross-tenant`,
        };
      }
    }
  }
  if (data?.type === 'data:update_message' && typeof payload?.messageId === 'string') {
    const m = (await dbGet(
      db
        .select({ threadId: schema.messages.threadId })
        .from(schema.messages)
        .where(eq(schema.messages.id, payload.messageId)),
    )) as { threadId: string } | undefined;
    if (!m) return { ok: false, reason: `message ${payload.messageId} not found` };
    const t = (await dbGet(
      db
        .select({ userId: schema.threads.userId })
        .from(schema.threads)
        .where(eq(schema.threads.id, m.threadId)),
    )) as { userId: string } | undefined;
    if (!t || t.userId !== runnerUserId) {
      return { ok: false, reason: `message ${payload.messageId} cross-tenant` };
    }
  }

  // ── Tool call ownership (toolCall → message → thread → user) ───
  const toolCallId =
    (data?.type === 'data:get_tool_call' && typeof data?.toolCallId === 'string'
      ? data.toolCallId
      : undefined) ??
    (data?.type === 'data:update_tool_call_output' && typeof payload?.toolCallId === 'string'
      ? payload.toolCallId
      : undefined);
  if (toolCallId) {
    const tc = (await dbGet(
      db
        .select({ messageId: schema.toolCalls.messageId })
        .from(schema.toolCalls)
        .where(eq(schema.toolCalls.id, toolCallId)),
    )) as { messageId: string } | undefined;
    if (!tc) return { ok: false, reason: `tool call ${toolCallId} not found` };
    const m = (await dbGet(
      db
        .select({ threadId: schema.messages.threadId })
        .from(schema.messages)
        .where(eq(schema.messages.id, tc.messageId)),
    )) as { threadId: string } | undefined;
    if (!m) return { ok: false, reason: `tool call ${toolCallId} orphaned` };
    const t = (await dbGet(
      db
        .select({ userId: schema.threads.userId })
        .from(schema.threads)
        .where(eq(schema.threads.id, m.threadId)),
    )) as { userId: string } | undefined;
    if (!t || t.userId !== runnerUserId) {
      return { ok: false, reason: `tool call ${toolCallId} cross-tenant` };
    }
  }

  // ── Queued message ownership (queue row → thread → user) ───────
  if (
    (data?.type === 'data:cancel_queued_message' || data?.type === 'data:update_queued_message') &&
    typeof data?.messageId === 'string'
  ) {
    const q = (await dbGet(
      db
        .select({ threadId: schema.messageQueue.threadId })
        .from(schema.messageQueue)
        .where(eq(schema.messageQueue.id, data.messageId)),
    )) as { threadId: string } | undefined;
    if (!q)
      return {
        ok: false,
        reason: `queued message ${data.messageId} not found`,
      };
    const t = (await dbGet(
      db
        .select({ userId: schema.threads.userId })
        .from(schema.threads)
        .where(eq(schema.threads.id, q.threadId)),
    )) as { userId: string } | undefined;
    if (!t || t.userId !== runnerUserId) {
      return {
        ok: false,
        reason: `queued message ${data.messageId} cross-tenant`,
      };
    }
  }

  // ── Watcher ownership (watcher.user_id) ────────────────────────
  // Mutations / reads that reference a watcher by id must belong to the
  // runner's user. Create (watcher_insert) and get_live_by_thread_key carry
  // a payload.threadId and are covered by the thread-ownership check above;
  // list_due / list_pending / list_by_user carry no entity and are scoped to
  // runnerUserId in the handler.
  if (
    (data?.type === 'data:watcher_update' || data?.type === 'data:watcher_get') &&
    typeof payload?.id === 'string'
  ) {
    const w = (await dbGet(
      db
        .select({ userId: schema.watchers.userId })
        .from(schema.watchers)
        .where(eq(schema.watchers.id, payload.id)),
    )) as { userId: string } | undefined;
    if (!w) return { ok: false, reason: `watcher ${payload.id} not found` };
    if (w.userId !== runnerUserId) {
      return { ok: false, reason: `watcher ${payload.id} cross-tenant` };
    }
  }

  // ── Job ownership (job.user_id) ────────────────────────────────
  // Same as watchers: job_update/job_get reference a job by id; job_insert
  // carries payload.threadId (thread-ownership check above); list ops carry no
  // entity and are scoped to runnerUserId in the handler.
  if (
    (data?.type === 'data:job_update' || data?.type === 'data:job_get') &&
    typeof payload?.id === 'string'
  ) {
    const j = (await dbGet(
      db
        .select({ userId: schema.jobs.userId })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, payload.id)),
    )) as { userId: string } | undefined;
    if (!j) return { ok: false, reason: `job ${payload.id} not found` };
    if (j.userId !== runnerUserId) {
      return { ok: false, reason: `job ${payload.id} cross-tenant` };
    }
  }

  return { ok: true };
}

/**
 * Handle a data persistence message from a runner (Socket.IO ack pattern).
 * Returns the response data instead of calling sendToRunner.
 *
 * `runnerUserId` is the DB-recorded owner of the runner; it is used to reject
 * any request that references entities belonging to a different user.
 */
export async function handleDataMessageWithAck(
  runnerId: string,
  runnerUserId: string | null,
  data: any,
): Promise<any> {
  try {
    const ownership = await assertDataOwnership(runnerUserId, data);
    if (!ownership.ok) {
      log.warn('Rejected cross-tenant data request from runner', {
        namespace: 'data-handler',
        runnerId,
        runnerUserId,
        type: data?.type,
        reason: ownership.reason,
      });
      audit({
        action: 'authz.cross_tenant_refused',
        actorId: runnerUserId,
        detail: `runner data request refused: ${data?.type}`,
        meta: {
          source: 'data-handler',
          runnerId,
          type: data?.type,
          reason: ownership.reason,
        },
      });
      return { type: 'data:ack', success: false, error: 'Forbidden' };
    }

    switch (data.type) {
      case 'data:insert_message': {
        const messageRepo = getMessageRepo();
        const messageId = await messageRepo.insertMessage(data.payload);
        return { type: 'data:insert_message_response', messageId };
      }
      case 'data:insert_tool_call': {
        const toolCallRepo = getToolCallRepo();
        const toolCallId = await toolCallRepo.insertToolCall(data.payload);
        return { type: 'data:insert_tool_call_response', toolCallId };
      }
      case 'data:update_thread': {
        const threadRepo = getThreadRepo();
        await threadRepo.updateThread(data.payload.threadId, data.payload.updates);
        return { type: 'data:update_thread_response', ok: true };
      }
      case 'data:update_message': {
        const messageRepo = getMessageRepo();
        await messageRepo.updateMessage(data.payload.messageId, data.payload.content);
        return undefined; // fire-and-forget
      }
      case 'data:delete_messages_after': {
        const messageRepo = getMessageRepo();
        const deletedCount = await messageRepo.deleteMessagesAfter(
          data.payload.threadId,
          data.payload.anchorMessageId,
        );
        return { type: 'data:delete_messages_after_response', deletedCount };
      }
      case 'data:update_tool_call_output': {
        const toolCallRepo = getToolCallRepo();
        await toolCallRepo.updateToolCallOutput(data.payload.toolCallId, data.payload.output);
        return undefined; // fire-and-forget
      }
      case 'data:get_thread': {
        const threadRepo = getThreadRepo();
        const thread = await threadRepo.getThread(data.threadId);
        return { type: 'data:get_thread_response', thread: thread ?? null };
      }
      case 'data:get_thread_by_external_request_id': {
        const threadRepo = getThreadRepo();
        const thread = await threadRepo.getThreadByExternalRequestId(data.externalRequestId);
        return {
          type: 'data:get_thread_by_external_request_id_response',
          thread: thread ?? null,
        };
      }
      case 'data:get_thread_by_session_id': {
        const threadRepo = getThreadRepo();
        const thread = await threadRepo.getThreadBySessionId(data.sessionId);
        return {
          type: 'data:get_thread_by_session_id_response',
          thread: thread ?? null,
        };
      }
      case 'data:get_thread_with_messages': {
        const messageRepo = getMessageRepo();
        const thread = await messageRepo.getThreadWithMessages(
          data.threadId,
          typeof data.messageLimit === 'number' ? data.messageLimit : undefined,
          {
            messageProgress:
              typeof data.messageProgress === 'number' ? data.messageProgress : undefined,
          },
        );
        return {
          type: 'data:get_thread_with_messages_response',
          thread: thread ?? null,
        };
      }
      case 'data:get_thread_messages': {
        const messageRepo = getMessageRepo();
        const result = await messageRepo.getThreadMessages({
          threadId: data.threadId,
          cursor: typeof data.cursor === 'string' ? data.cursor : undefined,
          limit: typeof data.limit === 'number' ? data.limit : 50,
          direction: data.direction === 'after' ? 'after' : 'before',
        });
        return {
          type: 'data:get_thread_messages_response',
          messages: result.messages,
          hasMore: result.hasMore,
          hasMoreAfter: result.hasMoreAfter,
          total: result.total,
          windowStart: result.windowStart,
          leadingUserMessage: result.leadingUserMessage,
        };
      }
      case 'data:get_tool_call': {
        const toolCallRepo = getToolCallRepo();
        const toolCall = await toolCallRepo.getToolCall(data.toolCallId);
        return {
          type: 'data:get_tool_call_response',
          toolCall: toolCall ?? null,
        };
      }
      case 'data:search_threads': {
        // Carries no entity id — scoped to the runner's own user (like the
        // watcher/job list ops), so no per-entity ownership check is needed.
        if (!runnerUserId) {
          return { type: 'data:search_threads_response', results: [] };
        }
        const { searchThreadMessages } = await import('./search-repository.js');
        const results = await searchThreadMessages({
          userId: runnerUserId,
          query: typeof data.query === 'string' ? data.query : undefined,
          author: typeof data.author === 'string' ? data.author : undefined,
          since: typeof data.since === 'string' ? data.since : undefined,
          until: typeof data.until === 'string' ? data.until : undefined,
          projectId: typeof data.projectId === 'string' ? data.projectId : undefined,
          limit: typeof data.limit === 'number' ? data.limit : undefined,
          caseSensitive: typeof data.caseSensitive === 'boolean' ? data.caseSensitive : undefined,
        });
        return { type: 'data:search_threads_response', results };
      }
      case 'data:find_tool_call': {
        const toolCallRepo = getToolCallRepo();
        const tc = await toolCallRepo.findToolCall(
          data.payload.messageId,
          data.payload.name,
          data.payload.input,
        );
        return { type: 'data:find_tool_call_response', toolCall: tc ?? null };
      }
      case 'data:find_last_unanswered_interactive_tool_call': {
        const toolCallRepo = getToolCallRepo();
        const tc = await toolCallRepo.findLastUnansweredInteractiveToolCall(data.threadId);
        return {
          type: 'data:find_last_unanswered_interactive_tool_call_response',
          toolCall: tc ?? null,
        };
      }
      case 'data:get_project': {
        const project = await projectRepo.getProject(data.projectId);
        return { type: 'data:get_project_response', project: project ?? null };
      }
      case 'data:get_startup_command': {
        const command = await startupCommandsRepo.getCommand(data.cmdId, data.projectId);
        return {
          type: 'data:get_startup_command_response',
          command: command ?? null,
        };
      }
      case 'data:get_agent_template': {
        // Check builtin templates first
        const { BUILTIN_AGENT_TEMPLATES } = await import('@funny/shared');
        const builtin = BUILTIN_AGENT_TEMPLATES.find(
          (t: { id: string }) => t.id === data.templateId,
        );
        if (builtin) {
          return {
            type: 'data:get_agent_template_response',
            template: builtin,
          };
        }
        const row = await dbGet(
          db
            .select()
            .from(schema.agentTemplates)
            .where(eq(schema.agentTemplates.id, data.templateId)),
        );
        return {
          type: 'data:get_agent_template_response',
          template: row ?? null,
        };
      }
      case 'data:list_projects': {
        // Collaborator model: the runner needs the user's owned projects AND
        // the projects they were added to directly — the latter carry the
        // member's own `localPath`, which path-scope uses to authorize file/git
        // access on the member's machine.
        const owned = await projectRepo.listProjects(data.userId);
        const ownedIds = new Set(owned.map((p) => p.id));
        const shared = (await projectRepo.listMemberProjects(data.userId)).filter(
          (p) => p.userId !== data.userId && !ownedIds.has(p.id),
        );
        return {
          type: 'data:list_projects_response',
          projects: [...owned, ...shared],
        };
      }
      case 'data:list_project_threads': {
        const threads = await dbAll(
          db
            .select({
              id: schema.threads.id,
              userId: schema.threads.userId,
              worktreePath: schema.threads.worktreePath,
              status: schema.threads.status,
            })
            .from(schema.threads)
            .where(
              and(eq(schema.threads.projectId, data.projectId), eq(schema.threads.archived, 0)),
            ),
        );
        return { type: 'data:list_project_threads_response', threads };
      }
      case 'data:resolve_project_path': {
        const result = await projectRepo.resolveProjectPath(data.projectId, data.userId);
        if (result.isOk()) {
          return {
            type: 'data:resolve_project_path_response',
            ok: true,
            path: result.value,
          };
        } else {
          return {
            type: 'data:resolve_project_path_response',
            ok: false,
            error: result.error.message,
          };
        }
      }
      case 'data:create_project': {
        // Skip filesystem checks — the runner already validated the path
        // (clone succeeded, or the runner ran HI-3 containment against its own
        // $HOME before proxying creation here).
        const orgId = (data.orgId as string | null | undefined) ?? null;
        const cpResult = await projectRepo.createProject(
          data.name,
          data.path,
          data.userId,
          orgId,
          true,
        );
        if (cpResult.isOk()) {
          if (orgId) {
            await projectRepo.addProjectToOrg(cpResult.value.id, orgId);
          }
          // Assign the project to the creating runner here, on the same
          // round-trip that persisted it. The runner also fires a separate
          // `runner:assign_project` message, but that path can be lost (its
          // ack is dropped under the data-channel request/response shim),
          // which orphans the project — project-scoped routing (terminal/PTY
          // via findRunnerForProject) then fails until the next runner
          // restart. assignProject is idempotent (onConflictDoUpdate), so the
          // redundant write is harmless.
          try {
            const rm = await import('./runner-manager.js');
            await rm.assignProject(runnerId, {
              projectId: cpResult.value.id,
              localPath: cpResult.value.path,
            });
          } catch (e) {
            log.warn('Failed to auto-assign created project to runner', {
              namespace: 'data-handler',
              runnerId,
              projectId: cpResult.value.id,
              error: (e as Error).message,
            });
          }
          return {
            type: 'data:create_project_response',
            project: cpResult.value,
          };
        } else {
          return {
            type: 'data:create_project_response',
            error: cpResult.error.message,
            errorType: cpResult.error.type,
          };
        }
      }
      case 'data:create_thread': {
        const tRepo = getThreadRepo();
        await tRepo.createThread(data.payload);
        return { type: 'data:ack', success: true };
      }
      case 'data:delete_thread': {
        const tRepo = getThreadRepo();
        await tRepo.deleteThread(data.threadId);
        return { type: 'data:ack', success: true };
      }
      case 'data:enqueue_message': {
        const queued = await messageQueueRepo.enqueue(data.threadId, data.payload);
        return { type: 'data:enqueue_message_response', queued };
      }
      case 'data:dequeue_message': {
        const dequeued = await messageQueueRepo.dequeue(data.threadId);
        return { type: 'data:dequeue_message_response', dequeued };
      }
      case 'data:peek_message': {
        const peeked = await messageQueueRepo.peek(data.threadId);
        return { type: 'data:peek_message_response', peeked };
      }
      case 'data:queue_count': {
        const count = await messageQueueRepo.queueCount(data.threadId);
        return { type: 'data:queue_count_response', count };
      }
      case 'data:list_queue': {
        const items = await messageQueueRepo.listQueue(data.threadId);
        return { type: 'data:list_queue_response', items };
      }
      case 'data:cancel_queued_message': {
        // Ownership guard above already verified message → thread → runnerUserId.
        // Resolve threadId here so cancel can scope by (messageId, threadId).
        const q = (await dbGet(
          db
            .select({ threadId: schema.messageQueue.threadId })
            .from(schema.messageQueue)
            .where(eq(schema.messageQueue.id, data.messageId)),
        )) as { threadId: string } | undefined;
        if (!q)
          return {
            type: 'data:cancel_queued_message_response',
            success: false,
          };
        const success = await messageQueueRepo.cancel(data.messageId, q.threadId);
        return { type: 'data:cancel_queued_message_response', success };
      }
      case 'data:update_queued_message': {
        const q = (await dbGet(
          db
            .select({ threadId: schema.messageQueue.threadId })
            .from(schema.messageQueue)
            .where(eq(schema.messageQueue.id, data.messageId)),
        )) as { threadId: string } | undefined;
        if (!q) return { type: 'data:update_queued_message_response', updated: null };
        const updated = await messageQueueRepo.update(data.messageId, q.threadId, data.content);
        return { type: 'data:update_queued_message_response', updated };
      }
      case 'data:save_thread_event': {
        const { saveThreadEvent } = await import('./thread-event-repository.js');
        await saveThreadEvent(data.payload.threadId, data.payload.eventType, data.payload.data);
        return undefined; // fire-and-forget
      }
      case 'data:get_profile': {
        const { getProfile } = await import('./profile-service.js');
        const profile = await getProfile(data.userId);
        return { type: 'data:get_profile_response', profile: profile ?? null };
      }
      case 'data:get_provider_key': {
        const { getProviderKey } = await import('./profile-service.js');
        const key = await getProviderKey(data.userId, data.provider);
        return { type: 'data:get_provider_key_response', key: key ?? null };
      }
      case 'data:get_github_token': {
        const { getProviderKey } = await import('./profile-service.js');
        const token = await getProviderKey(data.userId, 'github');
        return { type: 'data:get_github_token_response', token: token ?? null };
      }
      case 'data:get_minimax_api_key': {
        const { getProviderKey } = await import('./profile-service.js');
        const key = await getProviderKey(data.userId, 'minimax');
        return { type: 'data:get_minimax_api_key_response', key: key ?? null };
      }
      case 'data:update_profile': {
        const { upsertProfile } = await import('./profile-service.js');
        const updatedProfile = await upsertProfile(data.userId, data.payload);
        return {
          type: 'data:update_profile_response',
          profile: updatedProfile,
        };
      }
      case 'data:resolve_agent_execution_profile': {
        const { resolveEffectiveProfile } = await import('./agent-execution-profile-repository.js');
        const resolved = await resolveEffectiveProfile(data.projectId, data.userId);
        return {
          type: 'data:resolve_agent_execution_profile_response',
          ...resolved,
        };
      }
      case 'data:get_builtin_providers': {
        // Owner-scoped: the runner asks for its owning user's stored selection.
        // Ownership guard above already required a non-null runnerUserId.
        if (!runnerUserId) {
          return { type: 'data:get_builtin_providers_response', active: null };
        }
        const { getBuiltinProviderSettings } = await import('./profile-service.js');
        const active = await getBuiltinProviderSettings(runnerUserId);
        return { type: 'data:get_builtin_providers_response', active };
      }
      case 'data:set_builtin_providers': {
        if (!runnerUserId) {
          return {
            type: 'data:ack',
            success: false,
            error: 'runner has no owning user',
          };
        }
        const { setBuiltinProviderSettings } = await import('./profile-service.js');
        const active = Array.isArray(data.active)
          ? data.active.filter((x: unknown): x is string => typeof x === 'string')
          : null;
        await setBuiltinProviderSettings(runnerUserId, active);
        return { type: 'data:ack', success: true };
      }
      case 'data:mark_and_list_stale_threads': {
        const threadRepo = getThreadRepo();
        const staleThreads = await threadRepo.markAndListStaleThreads(runnerId);
        return {
          type: 'data:mark_and_list_stale_threads_response',
          threads: staleThreads,
        };
      }

      // ── Agent watchers (deferred-wake "snooze") ──────────────────
      case 'data:watcher_insert': {
        await getWatcherRepo().insert(data.payload.row);
        return { type: 'data:watcher_insert_response', ok: true };
      }
      case 'data:watcher_get': {
        const watcher = await getWatcherRepo().getById(data.payload.id);
        return { type: 'data:watcher_get_response', watcher: watcher ?? null };
      }
      case 'data:watcher_get_live_by_thread_key': {
        const watcher = await getWatcherRepo().getLiveByThreadKey(
          data.payload.threadId,
          data.payload.key,
        );
        return {
          type: 'data:watcher_get_live_by_thread_key_response',
          watcher: watcher ?? null,
        };
      }
      case 'data:watcher_list_pending': {
        // Scoped to the runner's user — never another tenant's watchers.
        const watchers = await getWatcherRepo().listPending(runnerUserId ?? undefined);
        return { type: 'data:watcher_list_pending_response', watchers };
      }
      case 'data:watcher_list_due': {
        const watchers = await getWatcherRepo().listDue(
          data.payload.now,
          runnerUserId ?? undefined,
        );
        return { type: 'data:watcher_list_due_response', watchers };
      }
      case 'data:watcher_list_by_user': {
        const watchers = await getWatcherRepo().listByUser(runnerUserId ?? data.payload.userId);
        return { type: 'data:watcher_list_by_user_response', watchers };
      }
      case 'data:watcher_update': {
        await getWatcherRepo().update(data.payload.id, data.payload.patch);
        return { type: 'data:watcher_update_response', ok: true };
      }
      case 'data:watcher_delete_by_thread': {
        await getWatcherRepo().deleteByThread(data.payload.threadId);
        return { type: 'data:watcher_delete_by_thread_response', ok: true };
      }

      // ── Agent jobs ───────────────────────────────────────────────
      case 'data:job_insert': {
        await getJobRepo().insert(data.payload.row);
        return { type: 'data:job_insert_response', ok: true };
      }
      case 'data:job_get': {
        const job = await getJobRepo().getById(data.payload.id);
        return { type: 'data:job_get_response', job: job ?? null };
      }
      case 'data:job_list_running': {
        const jobs = await getJobRepo().listRunning(runnerUserId ?? undefined);
        return { type: 'data:job_list_running_response', jobs };
      }
      case 'data:job_list_by_user': {
        const jobs = await getJobRepo().listByUser(runnerUserId ?? data.payload.userId);
        return { type: 'data:job_list_by_user_response', jobs };
      }
      case 'data:job_update': {
        await getJobRepo().update(data.payload.id, data.payload.patch);
        return { type: 'data:job_update_response', ok: true };
      }
      case 'data:job_delete_by_thread': {
        await getJobRepo().deleteByThread(data.payload.threadId);
        return { type: 'data:job_delete_by_thread_response', ok: true };
      }

      default:
        log.warn('Unknown data message type from runner', {
          namespace: 'data-handler',
          runnerId,
          type: data.type,
        });
        return undefined;
    }
  } catch (err) {
    log.error('Failed to handle data message from runner', {
      namespace: 'data-handler',
      runnerId,
      type: data.type,
      error: (err as Error).message,
    });
    return { type: 'data:ack', success: false, error: (err as Error).message };
  }
}
