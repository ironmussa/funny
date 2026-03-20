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

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import * as messageQueueRepo from './message-queue-repository.js';
import * as projectRepo from './project-repository.js';
import { sendToRunner } from './ws-relay.js';

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
 * Handle a data persistence message from a runner (Socket.IO ack pattern).
 * Returns the response data instead of calling sendToRunner.
 */
export async function handleDataMessageWithAck(runnerId: string, data: any): Promise<any> {
  try {
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
      case 'data:get_project': {
        const project = await projectRepo.getProject(data.projectId);
        return { type: 'data:get_project_response', project: project ?? null };
      }
      case 'data:list_projects': {
        const projects = await projectRepo.listProjects(data.userId);
        return { type: 'data:list_projects_response', projects };
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
      case 'data:get_github_token': {
        const { getGithubToken } = await import('./profile-service.js');
        const token = await getGithubToken(data.userId);
        return { type: 'data:get_github_token_response', token: token ?? null };
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

/**
 * Handle a data persistence message from a runner (legacy pattern).
 * Persists the data and sends back a response via sendToRunner.
 * @deprecated Use handleDataMessageWithAck with Socket.IO acks instead.
 */
export async function handleDataMessage(runnerId: string, data: any): Promise<void> {
  try {
    switch (data.type) {
      case 'data:insert_message': {
        const messageRepo = getMessageRepo();
        const messageId = await messageRepo.insertMessage(data.payload);
        sendToRunner(runnerId, {
          type: 'data:insert_message_response',
          requestId: data.requestId,
          messageId,
        });
        break;
      }

      case 'data:insert_tool_call': {
        const toolCallRepo = getToolCallRepo();
        const toolCallId = await toolCallRepo.insertToolCall(data.payload);
        sendToRunner(runnerId, {
          type: 'data:insert_tool_call_response',
          requestId: data.requestId,
          toolCallId,
        });
        break;
      }

      case 'data:update_thread': {
        const threadRepo = getThreadRepo();
        await threadRepo.updateThread(data.payload.threadId, data.payload.updates);
        // Respond so the runner can await confirmation
        if (data.requestId) {
          sendToRunner(runnerId, {
            type: 'data:update_thread_response',
            requestId: data.requestId,
            ok: true,
          });
        }
        break;
      }

      case 'data:update_message': {
        const messageRepo = getMessageRepo();
        await messageRepo.updateMessage(data.payload.messageId, data.payload.content);
        break;
      }

      case 'data:update_tool_call_output': {
        const toolCallRepo = getToolCallRepo();
        await toolCallRepo.updateToolCallOutput(data.payload.toolCallId, data.payload.output);
        break;
      }

      case 'data:get_thread': {
        const threadRepo = getThreadRepo();
        const thread = await threadRepo.getThread(data.threadId);
        sendToRunner(runnerId, {
          type: 'data:get_thread_response',
          requestId: data.requestId,
          thread: thread ?? null,
        });
        break;
      }

      case 'data:get_tool_call': {
        const toolCallRepo = getToolCallRepo();
        const toolCall = await toolCallRepo.getToolCall(data.toolCallId);
        sendToRunner(runnerId, {
          type: 'data:get_tool_call_response',
          requestId: data.requestId,
          toolCall: toolCall ?? null,
        });
        break;
      }

      case 'data:find_tool_call': {
        const toolCallRepo = getToolCallRepo();
        const tc = await toolCallRepo.findToolCall(
          data.payload.messageId,
          data.payload.name,
          data.payload.input,
        );
        sendToRunner(runnerId, {
          type: 'data:find_tool_call_response',
          requestId: data.requestId,
          toolCall: tc ?? null,
        });
        break;
      }

      // ── Project operations ──────────────────────────────────

      case 'data:get_project': {
        const project = await projectRepo.getProject(data.projectId);
        sendToRunner(runnerId, {
          type: 'data:get_project_response',
          requestId: data.requestId,
          project: project ?? null,
        });
        break;
      }

      case 'data:list_projects': {
        const projects = await projectRepo.listProjects(data.userId);
        sendToRunner(runnerId, {
          type: 'data:list_projects_response',
          requestId: data.requestId,
          projects,
        });
        break;
      }

      case 'data:resolve_project_path': {
        const result = await projectRepo.resolveProjectPath(data.projectId, data.userId);
        if (result.isOk()) {
          sendToRunner(runnerId, {
            type: 'data:resolve_project_path_response',
            requestId: data.requestId,
            ok: true,
            path: result.value,
          });
        } else {
          sendToRunner(runnerId, {
            type: 'data:resolve_project_path_response',
            requestId: data.requestId,
            ok: false,
            error: result.error.message,
          });
        }
        break;
      }

      // ── Thread creation/deletion ──────────────────────────

      case 'data:create_thread': {
        const tRepo = getThreadRepo();
        await tRepo.createThread(data.payload);
        sendToRunner(runnerId, {
          type: 'data:ack',
          requestId: data.requestId,
          success: true,
        });
        break;
      }

      case 'data:delete_thread': {
        const tRepo = getThreadRepo();
        await tRepo.deleteThread(data.threadId);
        sendToRunner(runnerId, {
          type: 'data:ack',
          requestId: data.requestId,
          success: true,
        });
        break;
      }

      // ── Message queue ─────────────────────────────────────

      case 'data:enqueue_message': {
        const queued = await messageQueueRepo.enqueue(data.threadId, data.payload);
        sendToRunner(runnerId, {
          type: 'data:enqueue_message_response',
          requestId: data.requestId,
          queued,
        });
        break;
      }

      case 'data:dequeue_message': {
        const dequeued = await messageQueueRepo.dequeue(data.threadId);
        sendToRunner(runnerId, {
          type: 'data:dequeue_message_response',
          requestId: data.requestId,
          dequeued,
        });
        break;
      }

      case 'data:peek_message': {
        const peeked = await messageQueueRepo.peek(data.threadId);
        sendToRunner(runnerId, {
          type: 'data:peek_message_response',
          requestId: data.requestId,
          peeked,
        });
        break;
      }

      case 'data:queue_count': {
        const count = await messageQueueRepo.queueCount(data.threadId);
        sendToRunner(runnerId, {
          type: 'data:queue_count_response',
          requestId: data.requestId,
          count,
        });
        break;
      }

      case 'data:list_queue': {
        const items = await messageQueueRepo.listQueue(data.threadId);
        sendToRunner(runnerId, {
          type: 'data:list_queue_response',
          requestId: data.requestId,
          items,
        });
        break;
      }

      case 'data:cancel_queued_message': {
        const success = await messageQueueRepo.cancel(data.messageId);
        sendToRunner(runnerId, {
          type: 'data:cancel_queued_message_response',
          requestId: data.requestId,
          success,
        });
        break;
      }

      case 'data:update_queued_message': {
        const updated = await messageQueueRepo.update(data.messageId, data.content);
        sendToRunner(runnerId, {
          type: 'data:update_queued_message_response',
          requestId: data.requestId,
          updated,
        });
        break;
      }

      // ── Thread events ─────────────────────────────────────

      case 'data:save_thread_event': {
        const { saveThreadEvent } = await import('./thread-event-repository.js');
        await saveThreadEvent(data.payload.threadId, data.payload.eventType, data.payload.data);
        break;
      }

      // ── Profile operations ─────────────────────────────────

      case 'data:get_profile': {
        const { getProfile } = await import('./profile-service.js');
        const profile = await getProfile(data.userId);
        sendToRunner(runnerId, {
          type: 'data:get_profile_response',
          requestId: data.requestId,
          profile: profile ?? null,
        });
        break;
      }

      case 'data:get_github_token': {
        const { getGithubToken } = await import('./profile-service.js');
        const token = await getGithubToken(data.userId);
        sendToRunner(runnerId, {
          type: 'data:get_github_token_response',
          requestId: data.requestId,
          token: token ?? null,
        });
        break;
      }

      case 'data:update_profile': {
        const { upsertProfile } = await import('./profile-service.js');
        const updatedProfile = await upsertProfile(data.userId, data.payload);
        sendToRunner(runnerId, {
          type: 'data:update_profile_response',
          requestId: data.requestId,
          profile: updatedProfile,
        });
        break;
      }

      // ── Arc operations ───────────────────────────────────

      case 'data:get_arc': {
        const arcRepository = getArcRepo();
        const arc = await arcRepository.getArc(data.arcId);
        sendToRunner(runnerId, {
          type: 'data:get_arc_response',
          requestId: data.requestId,
          arc: arc ?? null,
        });
        break;
      }

      default:
        log.warn('Unknown data message type from runner', {
          namespace: 'data-handler',
          runnerId,
          type: data.type,
        });
    }
  } catch (err) {
    log.error('Failed to handle data message from runner', {
      namespace: 'data-handler',
      runnerId,
      type: data.type,
      error: (err as Error).message,
    });

    // If this was a request expecting a response, send an error ack
    if (data.requestId) {
      sendToRunner(runnerId, {
        type: 'data:ack',
        requestId: data.requestId,
        success: false,
        error: (err as Error).message,
      });
    }
  }
}
