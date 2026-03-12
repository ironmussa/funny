/**
 * Local HTTP API exposed by the runner.
 * The central server can call these endpoints directly to execute
 * git operations on this runner's machine.
 */

import type { RunnerGitRequest } from '@funny/shared/runner-protocol';
import { Hono } from 'hono';

import { handleGitOperation } from './git-handler.js';

export function createLocalApi(runnerToken: string): Hono {
  const app = new Hono();

  // Simple bearer token auth — the central server must provide the runner's token
  app.use('*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (auth !== `Bearer ${runnerToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // Health check
  app.get('/health', (c) => {
    return c.json({ status: 'ok' });
  });

  // Git operations — the central server proxies git requests here
  app.post('/git', async (c) => {
    const body = await c.req.json<RunnerGitRequest>();
    const result = await handleGitOperation(body.operation, body.cwd, body.params);
    return c.json(result);
  });

  return app;
}
