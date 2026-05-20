import { Hono } from 'hono';
import { describe, test, expect } from 'vitest';

import { canDoGitOps } from '../../services/thread-context.js';

/**
 * Mirrors the middleware in `packages/runtime/src/routes/git.ts`. We
 * re-build it here against a fake getThread so the test stays focused on
 * the rule (`canDoGitOps(thread) === false → 400`) without spinning up
 * the full service registry.
 */
function makeGitApp(getThread: (id: string) => any | undefined) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const threadId = c.req.query('threadId') ?? c.req.param('threadId');
    if (!threadId) return next();
    const thread = getThread(threadId);
    if (thread && !canDoGitOps(thread)) {
      return c.json(
        {
          error: 'Git operations are not available for scratch threads',
          code: 'git-not-allowed-for-scratch',
        },
        400,
      );
    }
    return next();
  });
  app.get('/diff', (c) => c.json({ ok: true }));
  return app;
}

describe('git scratch guard middleware', () => {
  test('rejects requests for scratch threads with 400 + git-not-allowed-for-scratch', async () => {
    const app = makeGitApp(() => ({ id: 't-scratch', isScratch: true }));
    const res = await app.request('/diff?threadId=t-scratch');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('git-not-allowed-for-scratch');
  });

  test('passes through for non-scratch threads', async () => {
    const app = makeGitApp(() => ({ id: 't-normal', isScratch: false }));
    const res = await app.request('/diff?threadId=t-normal');
    expect(res.status).toBe(200);
  });

  test('passes through when threadId is missing', async () => {
    const app = makeGitApp(() => {
      throw new Error('should not be called');
    });
    const res = await app.request('/diff');
    expect(res.status).toBe(200);
  });

  test('passes through when thread cannot be found (let sub-route 404 naturally)', async () => {
    const app = makeGitApp(() => undefined);
    const res = await app.request('/diff?threadId=t-missing');
    expect(res.status).toBe(200);
  });
});
