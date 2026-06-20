/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * HTTP endpoint for VSCode-style text search across a thread's working
 * directory. Scope is resolved via {@link resolveThreadCwd} (worktree path
 * for worktree threads, project path for local, scratch dir for scratch),
 * then ripgrep does the heavy lifting.
 */

import { mkdirSync } from 'node:fs';

import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { getServices } from '../services/service-registry.js';
import { searchText } from '../services/text-search-service.js';
import { resolveThreadCwd } from '../services/thread-context.js';
import * as tm from '../services/thread-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { parseQuery, queryBoolean } from '../validation/request.js';

const NS = 'text-search-route';

const app = new Hono<HonoEnv>();

const textSearchQuerySchema = z.object({
  threadId: z.string().min(1, 'threadId is required'),
  q: z.string().default(''),
  caseSensitive: queryBoolean.default(false),
  wholeWord: queryBoolean.default(false),
  regex: queryBoolean.default(false),
  include: z.string().optional(),
  exclude: z.string().optional(),
  maxResults: z.coerce.number().positive().optional(),
});

/**
 * GET /api/search/text?threadId=...&q=...&caseSensitive=&wholeWord=&regex=&include=&exclude=&maxResults=
 *
 * Search for `q` inside the thread's resolved cwd. Always per-user — the
 * runner only ever serves threads owned by the requesting user (the
 * runner-isolation rule in CLAUDE.md), and we additionally verify
 * `thread.userId === userId` here.
 */
app.get('/text', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const parsedQuery = parseQuery(c, textSearchQuerySchema);
  if (parsedQuery.isErr()) return resultToResponse(c, parsedQuery);
  const {
    threadId,
    q: query,
    caseSensitive,
    wholeWord,
    regex,
    include,
    exclude,
    maxResults,
  } = parsedQuery.value;

  if (!query.trim()) return c.json({ error: 'q is required' }, 400);

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
  const cwd = cwdResult.value;

  // Scratch dirs are created lazily on first agent run — make sure the dir
  // exists so ripgrep doesn't fail on a missing path.
  if (thread.isScratch) {
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      // empty search will simply return zero results
    }
  }

  const result = await searchText(cwd, {
    query,
    caseSensitive,
    wholeWord,
    regex,
    include,
    exclude,
    maxResults,
  });

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
