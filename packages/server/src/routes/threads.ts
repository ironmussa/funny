/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ThreadService, AgentRunner, ThreadManager, WSBroker
 */

import type { DomainError } from '@funny/shared/errors';
import { badRequest, conflict, forbidden, internal, notFound } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';
import { requestSpan } from '../middleware/tracing.js';
import * as mq from '../services/message-queue.js';
import { getThreadEvents } from '../services/thread-event-service.js';
import * as tm from '../services/thread-manager.js';
import {
  createIdleThread,
  createAndStartThread,
  sendMessage,
  stopThread,
  approveToolCall,
  updateThread as updateThreadService,
  deleteThread as deleteThreadService,
  cancelQueuedMessage,
  updateQueuedMessage as updateQueuedMessageService,
  deleteComment as deleteCommentService,
  ThreadServiceError,
} from '../services/thread-service.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireThread, requireThreadWithMessages } from '../utils/route-helpers.js';
import {
  createThreadSchema,
  createIdleThreadSchema,
  sendMessageSchema,
  updateQueuedMessageSchema,
  updateThreadSchema,
  approveToolSchema,
  validate,
} from '../validation/schemas.js';

export const threadRoutes = new Hono<HonoEnv>();

/** Map a ThreadServiceError or unknown error to a DomainError */
function toDomainError(error: unknown): DomainError {
  if (error instanceof ThreadServiceError) {
    switch (error.statusCode) {
      case 400:
        return badRequest(error.message);
      case 403:
        return forbidden(error.message);
      case 404:
        return notFound(error.message);
      case 409:
        return conflict(error.message);
      default:
        return internal(error.message);
    }
  }

  const e = error as any;
  const isBinaryError =
    e.message?.includes('Could not find the claude CLI binary') ||
    e.message?.includes('CLAUDE_BINARY_PATH');

  if (isBinaryError) {
    return {
      type: 'INTERNAL',
      message:
        'The Claude Code CLI is not installed or not found in PATH. Please install it from https://docs.anthropic.com/en/docs/agents/overview',
    };
  }

  return internal(e.message || 'Unknown error occurred');
}

/** Format a ThreadServiceError into an HTTP response via resultToResponse */
function handleServiceError(c: any, error: unknown) {
  return resultToResponse(c, err(toDomainError(error)));
}

// ── GET routes (query-only, already thin) ────────────────────────

// GET /api/threads?projectId=xxx&includeArchived=true
threadRoutes.get('/', (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  const includeArchived = c.req.query('includeArchived') === 'true';
  const threads = tm.listThreads({ projectId: projectId || undefined, userId, includeArchived });
  return c.json(threads);
});

// GET /api/threads/archived?page=1&limit=100&search=xxx
threadRoutes.get('/archived', (c) => {
  const userId = c.get('userId') as string;
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(1000, Math.max(1, parseInt(c.req.query('limit') || '100', 10)));
  const search = c.req.query('search')?.trim() || '';

  const { threads, total } = tm.listArchivedThreads({ page, limit, search, userId });
  return c.json({ threads, total, page, limit });
});

// GET /api/threads/search/content?q=xxx&projectId=xxx
threadRoutes.get('/search/content', (c) => {
  const userId = c.get('userId') as string;
  const q = c.req.query('q')?.trim() || '';
  const projectId = c.req.query('projectId');
  if (!q) return c.json({ threadIds: [], snippets: {} });
  const matches = tm.searchThreadIdsByContent({
    query: q,
    projectId: projectId || undefined,
    userId,
  });
  return c.json({ threadIds: [...matches.keys()], snippets: Object.fromEntries(matches) });
});

// GET /api/threads/:id?messageLimit=50
threadRoutes.get('/:id', (c) => {
  const userId = c.get('userId') as string;
  const threadResult = requireThreadWithMessages(c.req.param('id'), userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  return c.json(threadResult.value);
});

// GET /api/threads/:id/messages?cursor=<ISO>&limit=50
threadRoutes.get('/:id/messages', (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');
  const limit = Math.min(200, Math.max(1, parseInt(limitParam || '50', 10)));

  const result = tm.getThreadMessages({ threadId: id, cursor: cursor || undefined, limit });
  return c.json(result);
});

// GET /api/threads/:id/events
threadRoutes.get('/:id/events', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const events = await getThreadEvents(id);
  return c.json({ events });
});

// ── POST routes (delegated to ThreadService) ────────────────────

// POST /api/threads/idle
threadRoutes.post('/idle', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(createIdleThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const userId = c.get('userId') as string;

  try {
    const thread = await createIdleThread({ ...parsed.value, userId });
    return c.json(thread, 201);
  } catch (error) {
    return handleServiceError(c, error);
  }
});

// POST /api/threads
threadRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(createThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const userId = c.get('userId') as string;
  const span = requestSpan(c, 'thread.create', {
    projectId: parsed.value.projectId,
    model: parsed.value.model,
  });

  try {
    const thread = await createAndStartThread({ ...parsed.value, userId });
    metric('threads.created', 1, { type: 'sum' });
    span.end('ok');
    return c.json(thread, 201);
  } catch (error) {
    span.end('error', error instanceof Error ? error.message : String(error));
    return handleServiceError(c, error);
  }
});

// POST /api/threads/:id/message
threadRoutes.post('/:id/message', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(sendMessageSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const span = requestSpan(c, 'thread.send_message', { threadId: id });
  try {
    const result = await sendMessage({ ...parsed.value, threadId: id, userId });
    span.end('ok');
    return c.json(result);
  } catch (error) {
    log.error('Failed to send message', { namespace: 'agent', threadId: id, error });
    span.end('error', error instanceof Error ? error.message : String(error));
    return handleServiceError(c, error);
  }
});

// POST /api/threads/:id/stop
threadRoutes.post('/:id/stop', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    await stopThread(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleServiceError(c, error);
  }
});

// POST /api/threads/:id/approve-tool
threadRoutes.post('/:id/approve-tool', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const parsed = validate(approveToolSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    await approveToolCall({ ...parsed.value, threadId: id, userId });
    return c.json({ ok: true });
  } catch (error) {
    log.error('Failed to approve tool', { namespace: 'agent', threadId: id, error });
    return handleServiceError(c, error);
  }
});

// ── PATCH / DELETE routes ───────────────────────────────────────

// PATCH /api/threads/:id
threadRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const parsed = validate(updateThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    const updated = await updateThreadService({ ...parsed.value, threadId: id, userId });
    return c.json(updated);
  } catch (error) {
    return handleServiceError(c, error);
  }
});

// ── Message Queue ────────────────────────────────────────────────

// GET /api/threads/:id/queue
threadRoutes.get('/:id/queue', (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  return c.json(mq.listQueue(id));
});

// DELETE /api/threads/:id/queue/:messageId
threadRoutes.delete('/:id/queue/:messageId', (c) => {
  const id = c.req.param('id');
  const messageId = c.req.param('messageId');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    const { queuedCount } = cancelQueuedMessage(id, messageId);
    return c.json({ ok: true, queuedCount });
  } catch (error) {
    return handleServiceError(c, error);
  }
});

// PATCH /api/threads/:id/queue/:messageId
threadRoutes.patch('/:id/queue/:messageId', async (c) => {
  const id = c.req.param('id');
  const messageId = c.req.param('messageId');
  const userId = c.get('userId') as string;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(updateQueuedMessageSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    const { queuedCount, queuedMessage } = updateQueuedMessageService(
      id,
      messageId,
      parsed.value.content,
    );
    return c.json({ ok: true, queuedCount, message: queuedMessage });
  } catch (error) {
    return handleServiceError(c, error);
  }
});

// ── Thread Comments ──────────────────────────────────────────────

// GET /api/threads/:id/comments
threadRoutes.get('/:id/comments', (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  return c.json(tm.listComments(id));
});

// POST /api/threads/:id/comments
threadRoutes.post('/:id/comments', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const { content } = await c.req.json();
  if (!content || typeof content !== 'string') {
    return c.json({ error: 'content is required' }, 400);
  }
  const comment = tm.insertComment({ threadId: id, userId, source: 'user', content });
  return c.json(comment, 201);
});

// DELETE /api/threads/:id/comments/:commentId
threadRoutes.delete('/:id/comments/:commentId', (c) => {
  const id = c.req.param('id');
  const commentId = c.req.param('commentId');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    deleteCommentService(id, commentId);
    return c.json({ ok: true });
  } catch (error) {
    return handleServiceError(c, error);
  }
});

// DELETE /api/threads/:id
threadRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(id, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    await deleteThreadService(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleServiceError(c, error);
  }
});
