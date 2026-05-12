/**
 * Thread routes for the central server.
 *
 * Data CRUD (list, get, update, delete) is handled natively using the server's DB.
 * Agent operations (create+start, stop, send message) are proxied to the runner.
 */

import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import {
  createThreadRepository,
  createMessageRepository,
  createCommentRepository,
  createStageHistoryRepository,
  createToolCallRepository,
} from '@funny/shared/repositories';
import { Hono } from 'hono';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import { startSpan } from '../lib/telemetry.js';
import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import * as messageQueueRepo from '../services/message-queue-repository.js';
import { findRunnerForProject } from '../services/runner-manager.js';
import * as runnerResolver from '../services/runner-resolver.js';
import type { ResolvedRunner } from '../services/runner-resolver.js';
import * as threadEventRepo from '../services/thread-event-repository.js';
import * as threadRegistry from '../services/thread-registry.js';
import { relayToUser } from '../services/ws-relay.js';
import { tunnelFetch } from '../services/ws-tunnel.js';

// Canonical thread-lifecycle enums — kept in sync with
// @funny/shared/primitives (ThreadStatus / ThreadStage). Inlined as
// arrays so the route can validate at the HTTP boundary without
// pulling a runtime value from a types-only package.
const THREAD_STATUS_VALUES = [
  'setting_up',
  'idle',
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'interrupted',
] as const;

const THREAD_STAGE_VALUES = [
  'backlog',
  'planning',
  'in_progress',
  'review',
  'done',
  'archived',
] as const;

const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET!;

// ── Shared repository instances ──────────────────────────────────

const commentRepo = createCommentRepository({ db, schema: schema as any, dbAll, dbRun });
const stageHistoryRepo = createStageHistoryRepository({ db, schema: schema as any, dbRun });
const threadRepo = createThreadRepository({
  db,
  schema: schema as any,
  dbAll,
  dbGet,
  dbRun,
  commentRepo,
  stageHistoryRepo,
});
const messageRepo = createMessageRepository({ db, schema: schema as any, dbAll, dbGet, dbRun });
const toolCallRepo = createToolCallRepository({ db, schema: schema as any, dbAll, dbGet, dbRun });

// ── Runner communication helpers ─────────────────────────────────

async function resolveRunnerForProject(
  projectId: string,
  userId?: string,
): Promise<ResolvedRunner | null> {
  const runnerResult = await findRunnerForProject(projectId);
  if (runnerResult) {
    return {
      runnerId: runnerResult.runner.runnerId,
      httpUrl: runnerResult.runner.httpUrl ?? null,
    };
  }
  return await runnerResolver.resolveRunner('/api/threads', { projectId }, userId);
}

async function fetchFromRunner(
  resolved: ResolvedRunner,
  path: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  if (resolved.runnerId === '__default__' && resolved.httpUrl) {
    return await directFetch(resolved.httpUrl, path, opts);
  }

  try {
    const resp = await tunnelFetch(resolved.runnerId, {
      method: opts.method,
      path,
      headers: opts.headers,
      body: opts.body ?? null,
    });
    return {
      ok: resp.status >= 200 && resp.status < 400,
      status: resp.status,
      body: resp.body ?? '',
    };
  } catch (tunnelErr) {
    if (resolved.httpUrl) {
      log.warn('Tunnel failed, falling back to direct HTTP', {
        namespace: 'threads',
        runnerId: resolved.runnerId,
        error: (tunnelErr as Error).message,
      });
      return await directFetch(resolved.httpUrl, path, opts);
    }
    throw tunnelErr;
  }
}

async function directFetch(
  baseUrl: string,
  path: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method,
    headers: opts.headers,
    body: opts.method !== 'GET' && opts.method !== 'HEAD' ? opts.body : undefined,
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

function buildForwardHeaders(
  userId: string,
  orgId?: string,
  role?: string,
  orgName?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-User': userId,
    'X-Runner-Auth': RUNNER_AUTH_SECRET,
  };
  if (orgId) headers['X-Forwarded-Org'] = orgId;
  if (orgName) headers['X-Forwarded-Org-Name'] = orgName;
  if (role) headers['X-Forwarded-Role'] = role;
  const { signature, timestamp } = signForwardedIdentity(
    { userId, role: role ?? null, orgId: orgId ?? null, orgName: orgName ?? null },
    RUNNER_AUTH_SECRET,
  );
  headers[SIGNATURE_HEADER] = signature;
  headers[TIMESTAMP_HEADER] = String(timestamp);
  return headers;
}

export const threadRoutes = new Hono<ServerEnv>();

// ── Data CRUD routes (handled natively) ──────────────────────────

// GET /api/threads?projectId=xxx&includeArchived=true&limit=50&offset=0
threadRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectId = c.req.query('projectId');
  const designId = c.req.query('designId');
  const includeArchived = c.req.query('includeArchived') === 'true';
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));

  const { threads, total } = await threadRepo.listThreads({
    projectId: projectId || undefined,
    designId: designId || undefined,
    userId,
    includeArchived,
    organizationId: orgId,
    limit,
    offset,
  });

  return c.json({ threads, total, hasMore: offset + threads.length < total });
});

// GET /api/threads/archived?page=1&limit=100&search=xxx
threadRoutes.get('/archived', async (c) => {
  const userId = c.get('userId') as string;
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(1000, Math.max(1, parseInt(c.req.query('limit') || '100', 10)));
  const search = c.req.query('search')?.trim() || '';

  const result = await threadRepo.listArchivedThreads({ page, limit, search, userId });
  return c.json({ ...result, page, limit });
});

// GET /api/threads/:id — get thread with messages
threadRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const limitParam = c.req.query('messageLimit');
  const messageLimit = limitParam
    ? Math.min(200, Math.max(1, parseInt(limitParam, 10)))
    : undefined;

  const span = startSpan('GET /api/threads/:id', {
    attributes: { 'thread.id': id, 'thread.message_limit': messageLimit ?? null },
  });
  try {
    // Fetch thread+messages, queue count, and queue head in parallel.
    // Ownership is checked off the thread row inside the same query result,
    // so we avoid a separate getThread() round-trip.
    const fetchSpan = startSpan('thread.fetch_with_messages', {
      traceId: span.traceId,
      parentSpanId: span.spanId,
      attributes: { 'thread.id': id },
    });
    const queueCountSpan = startSpan('thread.queue_count', {
      traceId: span.traceId,
      parentSpanId: span.spanId,
      attributes: { 'thread.id': id },
    });
    const queuePeekSpan = startSpan('thread.queue_peek', {
      traceId: span.traceId,
      parentSpanId: span.spanId,
      attributes: { 'thread.id': id },
    });
    const [result, queuedCount, queuedNext] = await Promise.all([
      messageRepo.getThreadWithMessages(id, messageLimit).finally(() => fetchSpan.end('ok')),
      messageQueueRepo.queueCount(id).finally(() => queueCountSpan.end('ok')),
      messageQueueRepo.peek(id).finally(() => queuePeekSpan.end('ok')),
    ]);

    if (!result || result.userId !== userId) {
      span.end('ok');
      return c.json({ error: 'Thread not found' }, 404);
    }

    span.attributes['thread.message_count'] = result.messages?.length ?? 0;
    span.attributes['thread.queued_count'] = queuedCount;
    span.end('ok');
    return c.json({
      ...result,
      queuedCount,
      queuedNextMessage: queuedNext?.content,
    });
  } catch (e) {
    span.end('error', e instanceof Error ? e.message : String(e));
    throw e;
  }
});

// GET /api/threads/:id/messages?cursor=<ISO>&limit=50
threadRoutes.get('/:id/messages', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) return c.json({ error: 'Thread not found' }, 404);

  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');
  const limit = Math.min(200, Math.max(1, parseInt(limitParam || '50', 10)));

  const result = await messageRepo.getThreadMessages({
    threadId: id,
    cursor: cursor || undefined,
    limit,
  });
  return c.json(result);
});

// GET /api/threads/:id/messages/search?q=xxx&limit=100
threadRoutes.get('/:id/messages/search', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) return c.json({ error: 'Thread not found' }, 404);

  const q = c.req.query('q') || '';
  const limitParam = c.req.query('limit');
  const limit = Math.min(200, Math.max(1, parseInt(limitParam || '100', 10)));
  const caseSensitive = c.req.query('caseSensitive') === 'true';

  if (!q.trim()) {
    return c.json({ results: [] });
  }

  const results = await messageRepo.searchMessages({
    threadId: id,
    query: q.trim(),
    limit,
    caseSensitive,
  });
  return c.json({ results });
});

// GET /api/threads/:id/comments
threadRoutes.get('/:id/comments', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) return c.json({ error: 'Thread not found' }, 404);

  const comments = await commentRepo.listComments(id);
  return c.json(comments);
});

// POST /api/threads/:id/comments
threadRoutes.post('/:id/comments', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) return c.json({ error: 'Thread not found' }, 404);

  const { content } = await c.req.json();

  if (!content || typeof content !== 'string') {
    return c.json({ error: 'content is required' }, 400);
  }

  const comment = await commentRepo.insertComment({
    threadId: id,
    userId,
    source: 'user',
    content,
  });
  return c.json(comment, 201);
});

// DELETE /api/threads/:id/comments/:commentId
threadRoutes.delete('/:id/comments/:commentId', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) return c.json({ error: 'Thread not found' }, 404);

  const commentId = c.req.param('commentId');
  await commentRepo.deleteComment(commentId);
  return c.json({ ok: true });
});

// PATCH /api/threads/:id — update thread data
threadRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const body = await c.req.json();

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) return c.json({ error: 'Thread not found' }, 404);

  // Extract only valid update fields
  const allowedFields = [
    'title',
    'status',
    'stage',
    'archived',
    'pinned',
    'orchestratorManaged',
    'model',
    'mode',
    'branch',
    'baseBranch',
    'permissionMode',
    'provider',
    'worktreePath',
  ];
  const updates: Record<string, any> = {};
  for (const key of allowedFields) {
    if (body[key] !== undefined) {
      updates[key] = body[key];
    }
  }

  // PostgreSQL integer columns need boolean → integer conversion
  if (typeof updates.pinned === 'boolean') updates.pinned = updates.pinned ? 1 : 0;
  if (typeof updates.archived === 'boolean') updates.archived = updates.archived ? 1 : 0;
  if (typeof updates.orchestratorManaged === 'boolean') {
    updates.orchestratorManaged = updates.orchestratorManaged ? 1 : 0;
  }

  if (Object.keys(updates).length > 0) {
    await threadRepo.updateThread(id, updates);
  }

  const updated = await threadRepo.getThread(id);
  return c.json(updated);
});

// ── Lifecycle endpoints used by the YAML pipeline DSL ───────
//
// `set_status` / `set_stage` actions in `.funny/pipelines/*.yaml`
// post to these routes (when the pipeline runs server-side, e.g. in
// the orchestrator's tunnel adapter). Dedicated endpoints — instead
// of relying on PATCH /:id — give us strict enum validation and a
// single emission point for the WS event that the kanban UI listens
// on.
threadRoutes.patch('/:id/status', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  let body: { value?: unknown; reason?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.value !== 'string') {
    return c.json({ error: 'Missing required string field "value"' }, 400);
  }
  if (!(THREAD_STATUS_VALUES as readonly string[]).includes(body.value)) {
    return c.json(
      {
        error: `Invalid status "${body.value}". Allowed: ${THREAD_STATUS_VALUES.join(', ')}`,
      },
      400,
    );
  }
  const reason = typeof body.reason === 'string' ? body.reason : undefined;

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  await threadRepo.updateThread(id, { status: body.value });
  relayToUser(userId, {
    type: 'thread:updated',
    threadId: id,
    data: { status: body.value, reason },
  });

  log.info('Thread status patched', {
    namespace: 'threads',
    threadId: id,
    status: body.value,
    reason,
  });

  const updated = await threadRepo.getThread(id);
  return c.json(updated);
});

threadRoutes.patch('/:id/stage', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  let body: { value?: unknown; reason?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.value !== 'string') {
    return c.json({ error: 'Missing required string field "value"' }, 400);
  }
  if (!(THREAD_STAGE_VALUES as readonly string[]).includes(body.value)) {
    return c.json(
      {
        error: `Invalid stage "${body.value}". Allowed: ${THREAD_STAGE_VALUES.join(', ')}`,
      },
      400,
    );
  }
  const reason = typeof body.reason === 'string' ? body.reason : undefined;

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  const fromStage = thread.stage;
  await threadRepo.updateThread(id, { stage: body.value });
  if (body.value !== fromStage) {
    await stageHistoryRepo.recordStageChange(id, fromStage ?? null, body.value);
    relayToUser(userId, {
      type: 'thread:stage-changed',
      threadId: id,
      data: {
        fromStage,
        toStage: body.value,
        projectId: thread.projectId,
        reason,
      },
    });
  }

  log.info('Thread stage patched', {
    namespace: 'threads',
    threadId: id,
    fromStage,
    toStage: body.value,
    reason,
  });

  const updated = await threadRepo.getThread(id);
  return c.json(updated);
});

// ── Workflow event fan-out (orchestrator-bound) ─────────────
//
// The (co-located) orchestrator binary posts here when a pipeline step
// emits a generic message — `notify` actions, log lines, etc. The server
// persists the event as a thread:event in the DB and broadcasts the same
// envelope shape used by emitWorkflowEvent in the runtime, so existing
// client listeners work unchanged.
threadRoutes.post('/:id/workflow-event', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  let body: { type?: unknown; data?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.type !== 'string' || !body.type) {
    return c.json({ error: 'Missing required string field "type"' }, 400);
  }
  // Constrain the event type to the workflow:* / pipeline:* namespaces so
  // a forwarded user can't synthesize unrelated events (eg. agent:result).
  if (!body.type.startsWith('workflow:') && !body.type.startsWith('pipeline:')) {
    return c.json({ error: 'type must start with "workflow:" or "pipeline:"' }, 400);
  }
  const data: Record<string, unknown> =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {};

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  await threadEventRepo.saveThreadEvent(id, body.type, data);

  // Mirror broadcastThreadEvent shape from packages/runtime/src/services/workflow-event-helpers.ts
  const eventId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  relayToUser(userId, {
    type: 'thread:event',
    threadId: id,
    data: {
      event: {
        id: eventId,
        threadId: id,
        type: body.type,
        data: JSON.stringify(data),
        createdAt,
      },
    },
  });

  return c.json({ ok: true, eventId });
});

// ── Thread creation (proxied to runner, then registered locally) ─

/** Shared handler for creating threads on a runner and registering them locally. */
async function createThreadOnRunner(c: any, runnerPath: string) {
  const userId = c.get('userId') as string;
  const body = await c.req.json();
  const projectId = body.projectId;

  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const resolved = await resolveRunnerForProject(projectId, userId);
  if (!resolved) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  try {
    const headers = buildForwardHeaders(
      userId,
      c.get('organizationId') as string | undefined,
      c.get('userRole') as string | undefined,
      c.get('organizationName') as string | undefined,
    );
    const result = await fetchFromRunner(resolved, runnerPath, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      return c.json({ error: `Runner error: ${result.body}` }, result.status as any);
    }

    const threadData = JSON.parse(result.body);

    const threadId = threadData.id || threadData.thread?.id;
    if (threadId && resolved.runnerId !== '__default__') {
      await threadRegistry.registerThread({
        id: threadId,
        projectId,
        runnerId: resolved.runnerId,
        userId,
        title: body.title || threadData.title,
        model: body.model,
        mode: body.mode,
        // Use runtime response data — the runtime generates the worktree
        // branch name, so body.branch is typically undefined for new threads.
        branch: threadData.branch ?? body.branch,
      });

      runnerResolver.cacheThreadRunner(threadId, resolved.runnerId, resolved.httpUrl);
    }

    return c.json(threadData, 201);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const stack = (err as Error).stack;
    log.error('Failed to create thread on runner', {
      namespace: 'threads',
      error: message,
      stack,
      path: runnerPath,
    });
    return c.json({ error: 'Thread creation failed' }, 502);
  }
}

// POST /api/threads — Create a new thread
threadRoutes.post('/', (c) => createThreadOnRunner(c, '/api/threads'));

// POST /api/threads/idle — Create an idle thread
threadRoutes.post('/idle', (c) => createThreadOnRunner(c, '/api/threads/idle'));

// ── Agent operations (proxied to runner) ─────────────────────────

// POST /api/threads/:id/orchestrator/workflow-event — orchestrator-bound
// Generic event fan-out for the standalone orchestrator. Mirrors the
// in-process pipeline-adapter's `notify()` path: the orchestrator pushes
// a workflow event here and the server relays it to the user's browser
// clients via Socket.IO.
threadRoutes.post('/:id/orchestrator/workflow-event', async (c) => {
  const threadId = c.req.param('id');
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    event?: string;
    data?: Record<string, unknown>;
  } | null;

  const event = body?.event;
  if (typeof event !== 'string' || !event.startsWith('workflow:')) {
    return c.json({ error: 'event must be a string starting with "workflow:"' }, 400);
  }

  relayToUser(userId, {
    type: event,
    threadId,
    data: { ...(body?.data ?? {}) },
  });

  return c.json({ ok: true });
});

// POST /api/threads/:id/message — send message to running agent
threadRoutes.post('/:id/message', proxyToRunner);

// POST /api/threads/:id/stop — stop running agent
threadRoutes.post('/:id/stop', proxyToRunner);

// POST /api/threads/:id/approve-tool — approve a tool call
threadRoutes.post('/:id/approve-tool', proxyToRunner);

// POST /api/threads/:id/convert-to-worktree — convert local thread to worktree
threadRoutes.post('/:id/convert-to-worktree', proxyToRunner);

// POST /api/threads/:id/fork — fork conversation at a user message
threadRoutes.post('/:id/fork', async (c) => {
  const sourceThreadId = c.req.param('id');
  const userId = c.get('userId') as string;

  const source = await threadRepo.getThread(sourceThreadId);
  if (!source || source.userId !== userId) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  const resolved = await resolveRunnerForProject(source.projectId, userId);
  if (!resolved) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  try {
    const headers = buildForwardHeaders(
      userId,
      c.get('organizationId') as string | undefined,
      c.get('userRole') as string | undefined,
      c.get('organizationName') as string | undefined,
    );
    const body = await c.req.text();
    const result = await fetchFromRunner(resolved, `/api/threads/${sourceThreadId}/fork`, {
      method: 'POST',
      headers,
      body,
    });

    if (!result.ok) {
      return c.json({ error: `Runner error: ${result.body}` }, result.status as any);
    }

    const newThread = JSON.parse(result.body);
    const newThreadId = newThread?.id;
    if (newThreadId && resolved.runnerId !== '__default__') {
      await threadRegistry.registerThread({
        id: newThreadId,
        projectId: source.projectId,
        runnerId: resolved.runnerId,
        userId,
        title: newThread.title,
        model: newThread.model,
        mode: newThread.mode,
        branch: newThread.branch ?? undefined,
      });
      runnerResolver.cacheThreadRunner(newThreadId, resolved.runnerId, resolved.httpUrl);
    }

    return c.json(newThread, 201);
  } catch (err) {
    log.error('Failed to fork thread on runner', {
      namespace: 'threads',
      sourceThreadId,
      error: (err as Error).message,
    });
    return c.json({ error: 'Thread fork failed' }, 502);
  }
});

// POST /api/threads/:id/rewind — proxy to runner
threadRoutes.post('/:id/rewind', proxyToRunner);

// POST /api/threads/:id/fork-and-rewind — fork conversation, then rewind code
threadRoutes.post('/:id/fork-and-rewind', async (c) => {
  const sourceThreadId = c.req.param('id');
  const userId = c.get('userId') as string;

  const source = await threadRepo.getThread(sourceThreadId);
  if (!source || source.userId !== userId) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  const resolved = await resolveRunnerForProject(source.projectId, userId);
  if (!resolved) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  try {
    const headers = buildForwardHeaders(
      userId,
      c.get('organizationId') as string | undefined,
      c.get('userRole') as string | undefined,
      c.get('organizationName') as string | undefined,
    );
    const body = await c.req.text();
    const result = await fetchFromRunner(
      resolved,
      `/api/threads/${sourceThreadId}/fork-and-rewind`,
      { method: 'POST', headers, body },
    );

    if (!result.ok) {
      return c.json({ error: `Runner error: ${result.body}` }, result.status as any);
    }

    const parsed = JSON.parse(result.body);
    const newThread = parsed?.thread ?? null;
    const newThreadId = newThread?.id;
    if (newThreadId && resolved.runnerId !== '__default__') {
      await threadRegistry.registerThread({
        id: newThreadId,
        projectId: source.projectId,
        runnerId: resolved.runnerId,
        userId,
        title: newThread.title,
        model: newThread.model,
        mode: newThread.mode,
        branch: newThread.branch ?? undefined,
      });
      runnerResolver.cacheThreadRunner(newThreadId, resolved.runnerId, resolved.httpUrl);
    }

    return c.json(parsed, 201);
  } catch (err) {
    log.error('Failed to fork-and-rewind thread on runner', {
      namespace: 'threads',
      sourceThreadId,
      error: (err as Error).message,
    });
    return c.json({ error: 'Thread fork-and-rewind failed' }, 502);
  }
});

// PATCH /api/threads/:id/tool-calls/:toolCallId — update tool call output
threadRoutes.patch('/:id/tool-calls/:toolCallId', proxyToRunner);

// GET /api/threads/:id/events — served from server DB
threadRoutes.get('/:id/events', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const span = startSpan('GET /api/threads/:id/events', {
    attributes: { 'thread.id': id },
  });
  try {
    // Run the ownership lookup and the events query in parallel — events
    // is the slow leg and can't read user data we wouldn't already return.
    const { getThreadEvents } = await import('../services/thread-event-repository.js');
    const ownerSpan = startSpan('thread.owner_check', {
      traceId: span.traceId,
      parentSpanId: span.spanId,
      attributes: { 'thread.id': id },
    });
    const eventsSpan = startSpan('thread.events.fetch', {
      traceId: span.traceId,
      parentSpanId: span.spanId,
      attributes: { 'thread.id': id },
    });
    const [thread, events] = await Promise.all([
      threadRepo.getThread(id).finally(() => ownerSpan.end('ok')),
      getThreadEvents(id).finally(() => eventsSpan.end('ok')),
    ]);

    if (!thread || thread.userId !== userId) {
      span.end('ok');
      return c.json({ error: 'Thread not found' }, 404);
    }

    span.attributes['thread.events_count'] = events.length;
    span.end('ok');
    return c.json({ events });
  } catch (e) {
    span.end('error', e instanceof Error ? e.message : String(e));
    throw e;
  }
});

// GET /api/threads/:id/touched-files — all unique file paths modified by Write/Edit/NotebookEdit
threadRoutes.get('/:id/touched-files', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) return c.json({ error: 'Thread not found' }, 404);

  const files = await toolCallRepo.getTouchedFiles(id);
  return c.json({ files });
});

// GET /api/threads/:id/queue — message queue is in the server's DB
threadRoutes.get('/:id/queue', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const thread = await threadRepo.getThread(id);
  if (!thread || thread.userId !== userId) return c.json({ error: 'Thread not found' }, 404);

  return c.json(await messageQueueRepo.listQueue(id));
});

// DELETE /api/threads/:id/queue/:messageId — cancel a queued message
threadRoutes.delete('/:id/queue/:messageId', async (c) => {
  const id = c.req.param('id');
  const messageId = c.req.param('messageId');
  const success = await messageQueueRepo.cancel(messageId);
  const queuedCount = await messageQueueRepo.queueCount(id);
  return c.json({ ok: success, queuedCount });
});

// PATCH /api/threads/:id/queue/:messageId — update a queued message
threadRoutes.patch('/:id/queue/:messageId', async (c) => {
  const id = c.req.param('id');
  const messageId = c.req.param('messageId');
  const { content } = await c.req.json();
  if (!content || typeof content !== 'string') {
    return c.json({ error: 'content is required' }, 400);
  }
  const updated = await messageQueueRepo.update(messageId, content);
  const queuedCount = await messageQueueRepo.queueCount(id);
  return c.json({ ok: !!updated, queuedCount, message: updated });
});

// ── Delete thread (native + proxy cleanup) ───────────────────────

threadRoutes.delete('/:id', async (c) => {
  const threadId = c.req.param('id');
  const userId = c.get('userId') as string;

  // Ownership check
  const thread = await threadRepo.getThread(threadId);
  if (!thread || thread.userId !== userId) return c.json({ error: 'Thread not found' }, 404);

  // Delete from local DB
  await threadRepo.deleteThread(threadId);

  // Find which runner handles this thread and clean up there too
  const runnerInfo = await threadRegistry.getRunnerForThread(threadId, userId);

  // Unregister from central DB and cache
  await threadRegistry.unregisterThread(threadId);
  runnerResolver.uncacheThread(threadId);

  // Proxy the delete to the runner
  if (runnerInfo) {
    const resolved: ResolvedRunner = {
      runnerId: runnerInfo.runnerId,
      httpUrl: runnerInfo.httpUrl,
    };
    try {
      const headers = buildForwardHeaders(
        userId,
        c.get('organizationId') as string | undefined,
        c.get('userRole') as string | undefined,
        c.get('organizationName') as string | undefined,
      );
      await fetchFromRunner(resolved, `/api/threads/${threadId}`, {
        method: 'DELETE',
        headers,
      });
    } catch {
      // Runner may be offline — that's ok, we already cleaned up the central DB
    }
  }

  return c.json({ ok: true });
});

// GET /api/threads/search/content?q=xxx&projectId=xxx&caseSensitive=true
threadRoutes.get('/search/content', async (c) => {
  const userId = c.get('userId') as string;
  const q = c.req.query('q') || '';
  const projectId = c.req.query('projectId');
  const caseSensitive = c.req.query('caseSensitive') === 'true';

  if (!q.trim()) {
    return c.json({ threadIds: [], snippets: {} });
  }

  const { searchThreadIdsByContent } = await import('../services/search-repository.js');
  const results = await searchThreadIdsByContent({ query: q, projectId, userId, caseSensitive });

  const threadIds = Array.from(results.keys());
  const snippets: Record<string, string> = {};
  for (const [id, snippet] of results) {
    snippets[id] = snippet;
  }

  return c.json({ threadIds, snippets });
});
