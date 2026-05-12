/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ThreadService, AgentRunner, ThreadManager, WSBroker
 *
 * Runner-only thread routes — agent operations and process management.
 * Thread data CRUD (list, get, update, delete, comments) is handled
 * by the server package directly.
 */

import type { DomainError } from '@funny/shared/errors';
import { badRequest, conflict, forbidden, internal, notFound } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';
import { requestSpan } from '../middleware/tracing.js';
import { getServices } from '../services/service-registry.js';
import * as tm from '../services/thread-manager.js';
import {
  createIdleThread,
  createAndStartThread,
  forkThread,
  forkAndRewind,
  rewindCode,
  sendMessage,
  stopThread,
  approveToolCall,
  cancelQueuedMessage,
  updateQueuedMessage as updateQueuedMessageService,
  convertToWorktree,
  ThreadServiceError,
} from '../services/thread-service.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireThread } from '../utils/route-helpers.js';
import {
  createThreadSchema,
  createIdleThreadSchema,
  forkThreadSchema,
  forkAndRewindSchema,
  rewindCodeSchema,
  sendMessageSchema,
  updateQueuedMessageSchema,
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

// ── Thread creation (agent operations) ───────────────────────

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
  const orgId = c.get('organizationId') ?? undefined;
  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const span = requestSpan(c, 'thread.send_message', { threadId: id });
  try {
    const result = await sendMessage({ ...parsed.value, threadId: id, userId });
    span.end('ok');
    return c.json(result);
  } catch (error) {
    log.error('Failed to send message', {
      namespace: 'agent',
      threadId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    span.end('error', error instanceof Error ? error.message : String(error));
    return handleServiceError(c, error);
  }
});

// POST /api/threads/:id/stop
threadRoutes.post('/:id/stop', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? undefined;
  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    await stopThread(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleServiceError(c, error);
  }
});

// POST /api/threads/:id/fork — fork the thread at a specific user message
threadRoutes.post('/:id/fork', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? undefined;
  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(forkThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const span = requestSpan(c, 'thread.fork', { threadId: id });
  try {
    const newThread = await forkThread({
      sourceThreadId: id,
      messageId: parsed.value.messageId,
      title: parsed.value.title,
      userId,
    });
    metric('threads.forked', 1, { type: 'sum' });
    span.end('ok');
    return c.json(newThread, 201);
  } catch (error) {
    log.error('Failed to fork thread', {
      namespace: 'agent',
      threadId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    span.end('error', error instanceof Error ? error.message : String(error));
    return handleServiceError(c, error);
  }
});

// POST /api/threads/:id/rewind — rewind code + truncate conversation in place
threadRoutes.post('/:id/rewind', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? undefined;
  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(rewindCodeSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const span = requestSpan(c, 'thread.rewind_code', { threadId: id });
  try {
    const result = await rewindCode({
      threadId: id,
      messageId: parsed.value.messageId,
      userId,
    });
    span.end('ok');
    return c.json(result);
  } catch (error) {
    log.error('Failed to rewind thread', {
      namespace: 'agent',
      threadId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    span.end('error', error instanceof Error ? error.message : String(error));
    return handleServiceError(c, error);
  }
});

// POST /api/threads/:id/fork-and-rewind — fork the thread then rewind code on the fork
threadRoutes.post('/:id/fork-and-rewind', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? undefined;
  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(forkAndRewindSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const span = requestSpan(c, 'thread.fork_and_rewind', { threadId: id });
  try {
    const result = await forkAndRewind({
      sourceThreadId: id,
      messageId: parsed.value.messageId,
      title: parsed.value.title,
      userId,
    });
    span.end('ok');
    return c.json(result, 201);
  } catch (error) {
    log.error('Failed to fork-and-rewind thread', {
      namespace: 'agent',
      threadId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    span.end('error', error instanceof Error ? error.message : String(error));
    return handleServiceError(c, error);
  }
});

// POST /api/threads/:id/convert-to-worktree
threadRoutes.post('/:id/convert-to-worktree', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? undefined;
  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const body = await c.req.json().catch(() => ({}));

  try {
    await convertToWorktree(id, userId, body.baseBranch);
    return c.json({ ok: true });
  } catch (error) {
    return handleServiceError(c, error);
  }
});

// POST /api/threads/:id/approve-tool
threadRoutes.post('/:id/approve-tool', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const raw = await c.req.json();
  const parsed = validate(approveToolSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    await approveToolCall({ ...parsed.value, threadId: id, userId });
    return c.json({ ok: true });
  } catch (error) {
    log.error('Failed to approve tool', { namespace: 'agent', threadId: id, error });
    return handleServiceError(c, error);
  }
});

// PATCH /api/threads/:id/tool-calls/:toolCallId — persist tool call output
threadRoutes.patch('/:id/tool-calls/:toolCallId', async (c) => {
  const id = c.req.param('id');
  const toolCallId = c.req.param('toolCallId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');

  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const body = await c.req.json<{ output: string }>();
  if (!body.output || typeof body.output !== 'string') {
    return resultToResponse(c, err(badRequest('output is required')));
  }

  try {
    await tm.updateToolCallOutput(toolCallId, body.output);
    return c.json({ ok: true });
  } catch (error) {
    return handleServiceError(c, error);
  }
});

// ── Thread events (runner-side storage) ──────────────────────

// GET /api/threads/:id/events
threadRoutes.get('/:id/events', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? undefined;
  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const events = await getServices().threadEvents.getThreadEvents(id);
  return c.json({ events });
});

// ── Message Queue ────────────────────────────────────────────

// GET /api/threads/:id/queue
threadRoutes.get('/:id/queue', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? undefined;
  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  return c.json(await getServices().messageQueue.listQueue(id));
});

// DELETE /api/threads/:id/queue/:messageId
threadRoutes.delete('/:id/queue/:messageId', async (c) => {
  const id = c.req.param('id');
  const messageId = c.req.param('messageId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? undefined;
  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    const { queuedCount } = await cancelQueuedMessage(id, messageId);
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
  const orgId = c.get('organizationId');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(updateQueuedMessageSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const threadResult = await requireThread(id, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  try {
    const { queuedCount, queuedMessage } = await updateQueuedMessageService(
      id,
      messageId,
      parsed.value.content,
    );
    return c.json({ ok: true, queuedCount, message: queuedMessage });
  } catch (error) {
    return handleServiceError(c, error);
  }
});
