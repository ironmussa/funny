import { describe, test, expect, beforeEach } from 'bun:test';

/**
 * Integration tests verifying tiered rate limits are applied to the correct route groups.
 * Tests that /api/threads/*, /api/git/*, and /api/worktrees/* have the stricter
 * mutationRateLimit (200/min) while other /api/* routes use the default (5000/min).
 */
import { Hono } from 'hono';

import { defaultRateLimit, mutationRateLimit } from '../../middleware/rate-limit.js';

describe('tiered rate limits on route groups', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();

    // Mirror the app.ts setup: default limit on all /api/*, then stricter on specific groups
    app.use('/api/*', defaultRateLimit());

    // Tiered: mutation-heavy endpoints get stricter limits
    app.use('/api/threads/*', mutationRateLimit());
    app.use('/api/git/*', mutationRateLimit());
    app.use('/api/worktrees/*', mutationRateLimit());

    // Mount test routes
    app.get('/api/health', (c) => c.json({ ok: true }));
    app.post('/api/threads/t1/message', (c) => c.json({ sent: true }));
    app.post('/api/git/t1/commit', (c) => c.json({ committed: true }));
    app.post('/api/worktrees', (c) => c.json({ created: true }));
    app.get('/api/browse/list', (c) => c.json({ files: [] }));
  });

  test('mutation endpoints (/api/threads/*) reject after 200 requests', async () => {
    // Send 200 requests — all should pass
    for (let i = 0; i < 200; i++) {
      const res = await app.request('/api/threads/t1/message', { method: 'POST' });
      expect(res.status).toBe(200);
    }
    // 201st should be rate-limited
    const res = await app.request('/api/threads/t1/message', { method: 'POST' });
    expect(res.status).toBe(429);
  });

  test('mutation endpoints (/api/git/*) reject after 200 requests', async () => {
    for (let i = 0; i < 200; i++) {
      const res = await app.request('/api/git/t1/commit', { method: 'POST' });
      expect(res.status).toBe(200);
    }
    const res = await app.request('/api/git/t1/commit', { method: 'POST' });
    expect(res.status).toBe(429);
  });

  test('mutation endpoints (/api/worktrees) reject after 200 requests', async () => {
    for (let i = 0; i < 200; i++) {
      const res = await app.request('/api/worktrees', { method: 'POST' });
      expect(res.status).toBe(200);
    }
    const res = await app.request('/api/worktrees', { method: 'POST' });
    expect(res.status).toBe(429);
  });

  test('non-mutation endpoints (/api/browse/*) allow more than 200 requests', async () => {
    // Send 250 requests — all should pass (default limit is 5000)
    for (let i = 0; i < 250; i++) {
      const res = await app.request('/api/browse/list');
      expect(res.status).toBe(200);
    }
  });

  test('health endpoint uses default limit (not mutation)', async () => {
    for (let i = 0; i < 250; i++) {
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
    }
  });

  test('different route groups have independent rate limit buckets', async () => {
    // Exhaust threads rate limit
    for (let i = 0; i < 200; i++) {
      await app.request('/api/threads/t1/message', { method: 'POST' });
    }
    const threadsRes = await app.request('/api/threads/t1/message', { method: 'POST' });
    expect(threadsRes.status).toBe(429);

    // Git endpoints should still work (separate bucket)
    const gitRes = await app.request('/api/git/t1/commit', { method: 'POST' });
    expect(gitRes.status).toBe(200);
  });
});
