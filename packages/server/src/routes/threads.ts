/**
 * Thread routes for the central server.
 *
 * Data CRUD (list, get, update, delete) is handled natively using the server's DB.
 * Agent operations (create+start, stop, send message) are proxied to the runner.
 */

import {
  createThreadRepository,
  createMessageRepository,
  createCommentRepository,
  createStageHistoryRepository,
} from '@funny/shared/repositories';
import { Hono } from 'hono';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import * as messageQueueRepo from '../services/message-queue-repository.js';
import { findRunnerForProject } from '../services/runner-manager.js';
import * as runnerResolver from '../services/runner-resolver.js';
import type { ResolvedRunner } from '../services/runner-resolver.js';
import * as threadRegistry from '../services/thread-registry.js';
import { tunnelFetch } from '../services/ws-tunnel.js';

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

function buildForwardHeaders(userId: string, orgId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-User': userId,
    'X-Runner-Auth': RUNNER_AUTH_SECRET,
  };
  if (orgId) headers['X-Forwarded-Org'] = orgId;
  return headers;
}

export const threadRoutes = new Hono<ServerEnv>();

// ── Data CRUD routes (handled natively) ──────────────────────────

// GET /api/threads?projectId=xxx&includeArchived=true
threadRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectId = c.req.query('projectId');
  const includeArchived = c.req.query('includeArchived') === 'true';

  const threads = await threadRepo.listThreads({
    projectId: projectId || undefined,
    userId,
    includeArchived,
    organizationId: orgId,
  });

  return c.json(threads);
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
  const limitParam = c.req.query('messageLimit');
  const messageLimit = limitParam
    ? Math.min(200, Math.max(1, parseInt(limitParam, 10)))
    : undefined;
  const result = await messageRepo.getThreadWithMessages(id, messageLimit);
  if (!result) return c.json({ error: 'Thread not found' }, 404);
  return c.json(result);
});

// GET /api/threads/:id/messages?cursor=<ISO>&limit=50
threadRoutes.get('/:id/messages', async (c) => {
  const id = c.req.param('id');
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

// GET /api/threads/:id/comments
threadRoutes.get('/:id/comments', async (c) => {
  const comments = await commentRepo.listComments(c.req.param('id'));
  return c.json(comments);
});

// POST /api/threads/:id/comments
threadRoutes.post('/:id/comments', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
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
  const commentId = c.req.param('commentId');
  await commentRepo.deleteComment(commentId);
  return c.json({ ok: true });
});

// PATCH /api/threads/:id — update thread data
threadRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const thread = await threadRepo.getThread(id);
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  // Extract only valid update fields
  const allowedFields = [
    'title',
    'status',
    'stage',
    'archived',
    'pinned',
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

  if (Object.keys(updates).length > 0) {
    await threadRepo.updateThread(id, updates);
  }

  const updated = await threadRepo.getThread(id);
  return c.json(updated);
});

// ── Thread creation (proxied to runner, then registered locally) ─

// POST /api/threads — Create a new thread
threadRoutes.post('/', async (c) => {
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
    const headers = buildForwardHeaders(userId, c.get('organizationId') as string | undefined);
    const result = await fetchFromRunner(resolved, '/api/threads', {
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
        branch: body.branch,
      });

      runnerResolver.cacheThreadRunner(threadId, resolved.runnerId, resolved.httpUrl);
    }

    return c.json(threadData, 201);
  } catch (err) {
    log.error('Failed to create thread on runner', {
      namespace: 'threads',
      error: (err as Error).message,
    });
    return c.json({ error: 'Runner unreachable' }, 502);
  }
});

// POST /api/threads/idle — Create an idle thread
threadRoutes.post('/idle', async (c) => {
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
    const headers = buildForwardHeaders(userId, c.get('organizationId') as string | undefined);
    const result = await fetchFromRunner(resolved, '/api/threads/idle', {
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
        branch: body.branch,
      });

      runnerResolver.cacheThreadRunner(threadId, resolved.runnerId, resolved.httpUrl);
    }

    return c.json(threadData, 201);
  } catch (err) {
    log.error('Failed to create idle thread on runner', {
      namespace: 'threads',
      error: (err as Error).message,
    });
    return c.json({ error: 'Runner unreachable' }, 502);
  }
});

// ── Agent operations (proxied to runner) ─────────────────────────

// POST /api/threads/:id/message — send message to running agent
threadRoutes.post('/:id/message', proxyToRunner);

// POST /api/threads/:id/stop — stop running agent
threadRoutes.post('/:id/stop', proxyToRunner);

// POST /api/threads/:id/approve-tool — approve a tool call
threadRoutes.post('/:id/approve-tool', proxyToRunner);

// PATCH /api/threads/:id/tool-calls/:toolCallId — update tool call output
threadRoutes.patch('/:id/tool-calls/:toolCallId', proxyToRunner);

// GET /api/threads/:id/events — served from server DB
threadRoutes.get('/:id/events', async (c) => {
  const id = c.req.param('id');
  const { getThreadEvents } = await import('../services/thread-event-repository.js');
  const events = await getThreadEvents(id);
  return c.json({ events });
});

// GET /api/threads/:id/queue — message queue is in the server's DB
threadRoutes.get('/:id/queue', async (c) => {
  const id = c.req.param('id');
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
      const headers = buildForwardHeaders(userId, c.get('organizationId') as string | undefined);
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

// GET /api/threads/search/content?q=xxx&projectId=xxx
threadRoutes.get('/search/content', async (c) => {
  const userId = c.get('userId') as string;
  const q = c.req.query('q') || '';
  const projectId = c.req.query('projectId');

  if (!q.trim()) {
    return c.json({ threadIds: [], snippets: {} });
  }

  const { searchThreadIdsByContent } = await import('../services/search-repository.js');
  const results = await searchThreadIdsByContent({ query: q, projectId, userId });

  const threadIds = Array.from(results.keys());
  const snippets: Record<string, string> = {};
  for (const [id, snippet] of results) {
    snippets[id] = snippet;
  }

  return c.json({ threadIds, snippets });
});
