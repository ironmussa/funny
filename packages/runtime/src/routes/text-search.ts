/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * HTTP endpoint for VSCode-style text search across a thread's working
 * directory. Scope is resolved via {@link resolveThreadCwd} (worktree path
 * for worktree threads, project path for local, scratch dir for scratch),
 * then the resident project search provider does the heavy lifting.
 */

import { mkdirSync } from 'node:fs';

import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { projectSearchRegistry } from '../services/project-search-registry.js';
import { getServices } from '../services/service-registry.js';
import { resolveThreadCwd } from '../services/thread-context.js';
import * as tm from '../services/thread-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { requireProjectPath } from '../utils/path-scope.js';
import { resultToResponse } from '../utils/result-response.js';
import { parseJsonBody, parseQuery, queryBoolean } from '../validation/request.js';

const NS = 'text-search-route';

const app = new Hono<HonoEnv>();

const textSearchQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  q: z.string().default(''),
  caseSensitive: queryBoolean.default(false),
  wholeWord: queryBoolean.default(false),
  regex: queryBoolean.default(false),
  include: z.string().optional(),
  exclude: z.string().optional(),
  maxResults: z.coerce.number().positive().optional(),
});

const fileSearchQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  q: z.string().default(''),
  limit: z.coerce.number().int().positive().max(1_000).default(100),
});

const fileSelectionBodySchema = z.object({
  threadId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  query: z.string(),
  relativePath: z.string().min(1),
});

/** Content-free diagnostics for the resident FFF search backend. */
app.get('/health', (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);
  return c.json(projectSearchRegistry.diagnostics());
});

/**
 * GET /api/search/files?threadId=...&q=...&limit=...
 * GET /api/search/files?path=...&q=...&limit=...
 *
 * Return server-ranked, repository-relative file matches for an authorized
 * project, worktree, or scratch cwd.
 */
app.get('/files', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const parsedQuery = parseQuery(c, fileSearchQuerySchema);
  if (parsedQuery.isErr()) return resultToResponse(c, parsedQuery);
  const { threadId: rawThreadId, path: rawPath, q: query, limit } = parsedQuery.value;

  const threadId = rawThreadId?.trim();
  const path = rawPath?.trim();
  if (!threadId && !path) {
    return c.json({ error: 'threadId or path is required' }, 400);
  }

  let cwd: string;
  if (threadId) {
    const thread = await tm.getThread(threadId);
    if (!thread || thread.userId !== userId) {
      return c.json({ error: 'Thread not found' }, 404);
    }

    const project = thread.projectId
      ? await getServices().projects.getProject(thread.projectId)
      : null;
    const cwdResult = resolveThreadCwd(
      thread as unknown as Parameters<typeof resolveThreadCwd>[0],
      project ? { path: project.path } : null,
    );
    if (cwdResult.isErr()) {
      return c.json({ error: cwdResult.error.message }, 400);
    }
    cwd = cwdResult.value;

    if (thread.isScratch) {
      try {
        mkdirSync(cwd, { recursive: true });
      } catch {
        // An empty or unavailable scratch directory is handled by the provider.
      }
    }
  } else {
    const denied = await requireProjectPath(path!, userId);
    if (denied) return denied;
    cwd = path!;
  }

  const leaseResult = await projectSearchRegistry.acquire(cwd);
  if (leaseResult.isErr()) return resultToResponse(c, leaseResult);

  const lease = leaseResult.value;
  try {
    const result = lease.provider.searchFiles(query, limit);
    if (result.isErr()) return resultToResponse(c, result);
    return c.json({ ...result.value, basePath: cwd });
  } finally {
    lease.release();
  }
});

/** Record a confirmed file-search selection for FFF ranking history. */
app.post('/files/selection', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const parsedBody = await parseJsonBody(c, fileSelectionBodySchema);
  if (parsedBody.isErr()) return resultToResponse(c, parsedBody);
  const { threadId: rawThreadId, path: rawPath, query, relativePath } = parsedBody.value;

  const threadId = rawThreadId?.trim();
  const path = rawPath?.trim();
  if (!threadId && !path) {
    return c.json({ error: 'threadId or path is required' }, 400);
  }

  let cwd: string;
  if (threadId) {
    const thread = await tm.getThread(threadId);
    if (!thread || thread.userId !== userId) {
      return c.json({ error: 'Thread not found' }, 404);
    }

    const project = thread.projectId
      ? await getServices().projects.getProject(thread.projectId)
      : null;
    const cwdResult = resolveThreadCwd(
      thread as unknown as Parameters<typeof resolveThreadCwd>[0],
      project ? { path: project.path } : null,
    );
    if (cwdResult.isErr()) {
      return c.json({ error: cwdResult.error.message }, 400);
    }
    cwd = cwdResult.value;
  } else {
    const denied = await requireProjectPath(path!, userId);
    if (denied) return denied;
    cwd = path!;
  }

  const leaseResult = await projectSearchRegistry.acquire(cwd);
  if (leaseResult.isErr()) return resultToResponse(c, leaseResult);

  const lease = leaseResult.value;
  try {
    const result = lease.provider.trackSelection(query.trim(), relativePath);
    if (result.isErr()) return resultToResponse(c, result);
    return c.json({ ok: true });
  } finally {
    lease.release();
  }
});

/**
 * GET /api/search/text?threadId=...&q=...&caseSensitive=&wholeWord=&regex=&include=&exclude=&maxResults=
 * GET /api/search/text?path=...&q=...&caseSensitive=&wholeWord=&regex=&include=&exclude=&maxResults=
 *
 * Search for `q` inside the thread's resolved cwd or a project path. Always per-user — the
 * runner only ever serves threads owned by the requesting user (the
 * runner-isolation rule in CLAUDE.md), and we additionally verify
 * `thread.userId === userId` here. Project paths are scoped through
 * requireProjectPath.
 */
app.get('/text', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const parsedQuery = parseQuery(c, textSearchQuerySchema);
  if (parsedQuery.isErr()) return resultToResponse(c, parsedQuery);
  const {
    threadId: rawThreadId,
    path: rawPath,
    q: query,
    caseSensitive,
    wholeWord,
    regex,
    include,
    exclude,
    maxResults,
  } = parsedQuery.value;

  if (!query.trim()) return c.json({ error: 'q is required' }, 400);

  const threadId = rawThreadId?.trim();
  const path = rawPath?.trim();
  if (!threadId && !path) {
    return c.json({ error: 'threadId or path is required' }, 400);
  }

  let cwd: string;

  if (threadId) {
    const thread = await tm.getThread(threadId);
    if (!thread || thread.userId !== userId) {
      return c.json({ error: 'Thread not found' }, 404);
    }

    const project = thread.projectId
      ? await getServices().projects.getProject(thread.projectId)
      : null;
    const cwdResult = resolveThreadCwd(
      thread as unknown as Parameters<typeof resolveThreadCwd>[0],
      project ? { path: project.path } : null,
    );
    if (cwdResult.isErr()) {
      return c.json({ error: cwdResult.error.message }, 400);
    }
    cwd = cwdResult.value;

    // Scratch dirs are created lazily on first agent run — make sure the dir
    // exists so ripgrep doesn't fail on a missing path.
    if (thread.isScratch) {
      try {
        mkdirSync(cwd, { recursive: true });
      } catch {
        // empty search will simply return zero results
      }
    }
  } else {
    const denied = await requireProjectPath(path!, userId);
    if (denied) return denied;
    cwd = path!;
  }

  const leaseResult = await projectSearchRegistry.acquire(cwd);
  if (leaseResult.isErr()) return resultToResponse(c, leaseResult);

  const lease = leaseResult.value;
  let result;
  try {
    result = await lease.provider.searchText({
      query,
      caseSensitive,
      wholeWord,
      regex,
      include,
      exclude,
      maxResults,
    });
  } finally {
    lease.release();
  }

  if (result.isErr()) {
    log.warn('text-search failed', {
      namespace: NS,
      threadId,
      userId,
      error: result.error.message,
    });
    return resultToResponse(c, result);
  }

  return c.json({
    ...result.value,
    /** Absolute base path so the client can build full paths for matches. */
    basePath: cwd,
  });
});

export const textSearchRoutes = app;
