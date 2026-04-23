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
  createArcRepository,
} from '@funny/shared/repositories';
import { and, eq } from 'drizzle-orm';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import * as messageQueueRepo from './message-queue-repository.js';
import * as projectRepo from './project-repository.js';

// Create shared repository instances (lazy-initialized)
let _messageRepo: ReturnType<typeof createMessageRepository> | null = null;
let _toolCallRepo: ReturnType<typeof createToolCallRepository> | null = null;
let _threadRepo: ReturnType<typeof createThreadRepository> | null = null;
let _arcRepo: ReturnType<typeof createArcRepository> | null = null;

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

function getArcRepo() {
  if (!_arcRepo) {
    _arcRepo = createArcRepository({
      db,
      schema: schema as any,
      dbAll,
      dbGet,
      dbRun,
    });
  }
  return _arcRepo;
}

/**
 * Verify that the runner owning `runnerUserId` is allowed to touch the
 * user/thread/project/message/tool-call/arc referenced by `data`.
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
    return { ok: false, reason: `userId ${candidateUserId} !== runner ${runnerUserId}` };
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
        return { ok: false, reason: `project ${projectId} owned by ${p.userId}` };
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
        return { ok: false, reason: `message ${messageIdForToolCall} cross-tenant` };
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
    if (!q) return { ok: false, reason: `queued message ${data.messageId} not found` };
    const t = (await dbGet(
      db
        .select({ userId: schema.threads.userId })
        .from(schema.threads)
        .where(eq(schema.threads.id, q.threadId)),
    )) as { userId: string } | undefined;
    if (!t || t.userId !== runnerUserId) {
      return { ok: false, reason: `queued message ${data.messageId} cross-tenant` };
    }
  }

  // ── Arc ownership ──────────────────────────────────────────────
  if (data?.type === 'data:get_arc' && typeof data?.arcId === 'string') {
    const a = (await dbGet(
      db
        .select({ userId: schema.arcs.userId })
        .from(schema.arcs)
        .where(eq(schema.arcs.id, data.arcId)),
    )) as { userId: string } | undefined;
    if (!a) return { ok: false, reason: `arc ${data.arcId} not found` };
    if (a.userId !== runnerUserId) {
      return { ok: false, reason: `arc ${data.arcId} cross-tenant` };
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
        meta: { source: 'data-handler', runnerId, type: data?.type, reason: ownership.reason },
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
      case 'data:get_thread_with_messages': {
        const messageRepo = getMessageRepo();
        const thread = await messageRepo.getThreadWithMessages(data.threadId, data.messageLimit);
        return { type: 'data:get_thread_with_messages_response', thread: thread ?? null };
      }
      case 'data:get_tool_call': {
        const toolCallRepo = getToolCallRepo();
        const toolCall = await toolCallRepo.getToolCall(data.toolCallId);
        return { type: 'data:get_tool_call_response', toolCall: toolCall ?? null };
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
      case 'data:get_agent_template': {
        // Check builtin templates first
        const { BUILTIN_AGENT_TEMPLATES } = await import('@funny/shared');
        const builtin = BUILTIN_AGENT_TEMPLATES.find(
          (t: { id: string }) => t.id === data.templateId,
        );
        if (builtin) {
          return { type: 'data:get_agent_template_response', template: builtin };
        }
        const row = await dbGet(
          db
            .select()
            .from(schema.agentTemplates)
            .where(eq(schema.agentTemplates.id, data.templateId)),
        );
        return { type: 'data:get_agent_template_response', template: row ?? null };
      }
      case 'data:list_projects': {
        const projects = await projectRepo.listProjects(data.userId);
        return { type: 'data:list_projects_response', projects };
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
          return { type: 'data:resolve_project_path_response', ok: true, path: result.value };
        } else {
          return {
            type: 'data:resolve_project_path_response',
            ok: false,
            error: result.error.message,
          };
        }
      }
      case 'data:create_project': {
        // Skip filesystem checks — the runner already validated the path (clone succeeded)
        const cpResult = await projectRepo.createProject(
          data.name,
          data.path,
          data.userId,
          undefined,
          true,
        );
        if (cpResult.isOk()) {
          return { type: 'data:create_project_response', project: cpResult.value };
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
        const success = await messageQueueRepo.cancel(data.messageId);
        return { type: 'data:cancel_queued_message_response', success };
      }
      case 'data:update_queued_message': {
        const updated = await messageQueueRepo.update(data.messageId, data.content);
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
        return { type: 'data:update_profile_response', profile: updatedProfile };
      }
      case 'data:get_arc': {
        const arcRepository = getArcRepo();
        const arc = await arcRepository.getArc(data.arcId);
        return { type: 'data:get_arc_response', arc: arc ?? null };
      }
      case 'data:mark_and_list_stale_threads': {
        const threadRepo = getThreadRepo();
        const staleThreads = await threadRepo.markAndListStaleThreads(runnerId);
        return { type: 'data:mark_and_list_stale_threads_response', threads: staleThreads };
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
