/**
 * Thread routes for the central server.
 *
 * Intercepts thread creation and deletion to register/unregister
 * threads in the central DB (for routing and listing).
 * All other thread operations are proxied to the runner.
 */

import { Hono } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { findRunnerForProject, getRunnerHttpUrl } from '../services/runner-manager.js';
import * as runnerResolver from '../services/runner-resolver.js';
import * as threadRegistry from '../services/thread-registry.js';

export const threadRoutes = new Hono<ServerEnv>();

/**
 * POST /api/threads — Create a new thread.
 * 1. Resolve which runner should handle this project
 * 2. Proxy the creation request to the runner
 * 3. Register the thread in the central DB for routing
 */
threadRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json();
  const projectId = body.projectId;

  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  // Find a runner for this project
  const runnerResult = await findRunnerForProject(projectId);
  if (!runnerResult) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  const runnerHttpUrl = await getRunnerHttpUrl(runnerResult.runner.runnerId);
  if (!runnerHttpUrl) {
    return c.json({ error: 'Runner has no HTTP URL configured' }, 502);
  }

  // Proxy the thread creation to the runner
  try {
    const runnerResponse = await fetch(`${runnerHttpUrl}/api/threads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-User': userId,
        'X-Runner-Auth': process.env.RUNNER_AUTH_SECRET || 'funny-server-proxy',
        ...(c.get('organizationId')
          ? { 'X-Forwarded-Org': c.get('organizationId') as string }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (!runnerResponse.ok) {
      const errorBody = await runnerResponse.text();
      return c.json({ error: `Runner error: ${errorBody}` }, runnerResponse.status as any);
    }

    const threadData = (await runnerResponse.json()) as any;

    // Register the thread in the central DB
    const threadId = threadData.id || threadData.thread?.id;
    if (threadId) {
      await threadRegistry.registerThread({
        id: threadId,
        projectId,
        runnerId: runnerResult.runner.runnerId,
        userId,
        title: body.title || threadData.title,
        model: body.model,
        mode: body.mode,
        branch: body.branch,
      });

      // Cache in the resolver for fast lookups
      runnerResolver.cacheThreadRunner(threadId, runnerResult.runner.runnerId, runnerHttpUrl);
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

/**
 * POST /api/threads/idle — Create an idle thread.
 * Same logic as POST /api/threads but for the idle thread endpoint.
 */
threadRoutes.post('/idle', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json();
  const projectId = body.projectId;

  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const runnerResult = await findRunnerForProject(projectId);
  if (!runnerResult) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  const runnerHttpUrl = await getRunnerHttpUrl(runnerResult.runner.runnerId);
  if (!runnerHttpUrl) {
    return c.json({ error: 'Runner has no HTTP URL configured' }, 502);
  }

  try {
    const runnerResponse = await fetch(`${runnerHttpUrl}/api/threads/idle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-User': userId,
        'X-Runner-Auth': process.env.RUNNER_AUTH_SECRET || 'funny-server-proxy',
        ...(c.get('organizationId')
          ? { 'X-Forwarded-Org': c.get('organizationId') as string }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (!runnerResponse.ok) {
      const errorBody = await runnerResponse.text();
      return c.json({ error: `Runner error: ${errorBody}` }, runnerResponse.status as any);
    }

    const threadData = (await runnerResponse.json()) as any;

    const threadId = threadData.id || threadData.thread?.id;
    if (threadId) {
      await threadRegistry.registerThread({
        id: threadId,
        projectId,
        runnerId: runnerResult.runner.runnerId,
        userId,
        title: body.title || threadData.title,
        model: body.model,
        mode: body.mode,
        branch: body.branch,
      });

      runnerResolver.cacheThreadRunner(threadId, runnerResult.runner.runnerId, runnerHttpUrl);
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

/**
 * DELETE /api/threads/:id — Delete a thread.
 * Unregister from the central DB, then proxy the delete to the runner.
 */
threadRoutes.delete('/:id', async (c) => {
  const threadId = c.req.param('id');
  const userId = c.get('userId') as string;

  // Find which runner handles this thread
  const runnerInfo = await threadRegistry.getRunnerForThread(threadId);

  // Unregister from central DB and cache
  await threadRegistry.unregisterThread(threadId);
  runnerResolver.uncacheThread(threadId);

  // Proxy the delete to the runner
  if (runnerInfo) {
    try {
      await fetch(`${runnerInfo.httpUrl}/api/threads/${threadId}`, {
        method: 'DELETE',
        headers: {
          'X-Forwarded-User': userId,
          'X-Runner-Auth': process.env.RUNNER_AUTH_SECRET || 'funny-server-proxy',
          ...(c.get('organizationId')
            ? { 'X-Forwarded-Org': c.get('organizationId') as string }
            : {}),
        },
      });
    } catch {
      // Runner may be offline — that's ok, we already cleaned up the central DB
    }
  }

  return c.json({ ok: true });
});
