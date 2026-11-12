/**
 * REST groups retired in favour of tRPC (openspec adopt-trpc-browser-api, task
 * 6.1) must answer 404 on the server instead of falling through to the runner
 * proxy catch-all, while the paths that are still runner-owned keep reaching it.
 */
import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { refuseRetiredRestRoutes } from '../../routes/retired-rest.js';

function buildApp() {
  const proxied: string[] = [];
  const app = new Hono<ServerEnv>();
  // Stand-in for the GitHub App settings routes, mounted before the refusals.
  app.get('/api/settings/github-app', (c) => c.json({ githubApp: true }));
  refuseRetiredRestRoutes(app);
  // Stand-in for the runner proxy catch-all.
  app.all('/api/*', (c) => {
    proxied.push(`${c.req.method} ${c.req.path}`);
    return c.json({ proxied: true });
  });
  return { app, proxied };
}

describe('retired REST routes', () => {
  test.each([
    ['GET', '/api/settings/agent-profiles'],
    ['PUT', '/api/settings/smtp'],
    ['POST', '/api/settings/smtp/test'],
    ['GET', '/api/settings/agent-profiles/projects/p1'],
    ['GET', '/api/agent-templates'],
    ['POST', '/api/agent-templates/tpl-1/duplicate'],
    ['GET', '/api/watchers'],
    ['POST', '/api/watchers/w1/cancel'],
    ['GET', '/api/designs/d1'],
    ['DELETE', '/api/designs/d1'],
    ['GET', '/api/projects/p1/designs'],
    ['POST', '/api/projects/p1/designs'],
    ['GET', '/api/analytics/overview'],
    ['GET', '/api/push/config'],
    ['PUT', '/api/push/subscription'],
    ['GET', '/api/jobs'],
  ])('%s %s answers 404 and never reaches a runner', async (method, path) => {
    const { app, proxied } = buildApp();
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(proxied).toEqual([]);
  });

  test('the GitHub App settings stay on their own server route', async () => {
    const { app, proxied } = buildApp();
    expect(await (await app.request('/api/settings/github-app')).json()).toEqual({
      githubApp: true,
    });
    expect(proxied).toEqual([]);
  });

  test.each([
    ['GET', '/api/jobs/j1/log'],
    ['POST', '/api/jobs/j1/cancel'],
    ['POST', '/api/projects/p1/designs/directory'],
    ['DELETE', '/api/projects/p1/designs/d1/directory'],
  ])('%s %s still reaches the runner proxy', async (method, path) => {
    const { app, proxied } = buildApp();
    const res = await app.request(path, { method });
    expect(res.status).toBe(200);
    expect(proxied).toEqual([`${method} ${path}`]);
  });
});
