/**
 * Pipeline approval-respond route tests.
 *
 * Validates the runtime endpoint that resolves pending approvals from
 * `pipelineApprovalStore`. The route is mounted by the server via
 * `proxyToRunner`, but tests target the runtime route directly so the
 * proxy layer is not in scope.
 */

import { Hono } from 'hono';
import { describe, test, expect, beforeEach } from 'vitest';

import { pipelineRuntimeRoutes } from '../../routes/pipelines.js';
import { pipelineApprovalStore } from '../../services/pipeline-approval-store.js';
import type { HonoEnv } from '../../types/hono-env.js';

const userId = 'user-1';

function makeApp(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    return next();
  });
  app.route('/pipelines', pipelineRuntimeRoutes);
  return app;
}

const meta = {
  threadId: 'thread-1',
  userId,
  gateId: 'confirm',
  requestedAt: '2026-01-01T00:00:00Z',
};

describe('pipeline approval routes', () => {
  let app: Hono<HonoEnv>;

  beforeEach(() => {
    app = makeApp();
  });

  describe('POST /approvals/:approvalId/respond', () => {
    test('approve resolves the pending promise', async () => {
      const id = `t-${Math.random()}`;
      const promise = pipelineApprovalStore.register(id, meta);

      const res = await app.request(`/pipelines/approvals/${id}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', text: 'lgtm' }),
      });

      expect(res.status).toBe(200);
      await expect(promise).resolves.toEqual({ decision: 'approve', text: 'lgtm' });
    });

    test('reject with reason resolves the pending promise', async () => {
      const id = `t-${Math.random()}`;
      const promise = pipelineApprovalStore.register(id, meta);

      const res = await app.request(`/pipelines/approvals/${id}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'reject', text: 'breaks contract' }),
      });

      expect(res.status).toBe(200);
      await expect(promise).resolves.toEqual({ decision: 'reject', text: 'breaks contract' });
    });

    test('reject without reason returns 400', async () => {
      const id = `t-${Math.random()}`;
      const promise = pipelineApprovalStore.register(id, meta);

      const res = await app.request(`/pipelines/approvals/${id}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'reject' }),
      });

      expect(res.status).toBe(400);
      // Cleanup: resolve the pending promise so the test exits cleanly.
      pipelineApprovalStore.respond(id, userId, { decision: 'approve' });
      await promise;
    });

    test('unknown approvalId returns 404', async () => {
      const res = await app.request(`/pipelines/approvals/does-not-exist/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });

      expect(res.status).toBe(404);
    });

    test('responding to another user returns 403', async () => {
      const id = `t-${Math.random()}`;
      const promise = pipelineApprovalStore.register(id, { ...meta, userId: 'someone-else' });

      const res = await app.request(`/pipelines/approvals/${id}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });

      expect(res.status).toBe(403);
      // Cleanup
      pipelineApprovalStore.respond(id, 'someone-else', { decision: 'approve' });
      await promise;
    });

    test('invalid body returns 400', async () => {
      const id = `t-${Math.random()}`;
      const promise = pipelineApprovalStore.register(id, meta);

      const res = await app.request(`/pipelines/approvals/${id}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'maybe' }),
      });

      expect(res.status).toBe(400);
      pipelineApprovalStore.respond(id, userId, { decision: 'approve' });
      await promise;
    });
  });

  describe('GET /approvals/pending', () => {
    test('lists only the requesting user’s pending approvals', async () => {
      const myId = `t-${Math.random()}`;
      const otherId = `t-${Math.random()}`;
      const p1 = pipelineApprovalStore.register(myId, meta);
      const p2 = pipelineApprovalStore.register(otherId, { ...meta, userId: 'someone-else' });

      const res = await app.request('/pipelines/approvals/pending', { method: 'GET' });
      expect(res.status).toBe(200);
      const body: { pending: Array<{ approvalId: string }> } = await res.json();
      const ids = body.pending.map((p) => p.approvalId);
      expect(ids).toContain(myId);
      expect(ids).not.toContain(otherId);

      // Cleanup
      pipelineApprovalStore.respond(myId, userId, { decision: 'approve' });
      pipelineApprovalStore.respond(otherId, 'someone-else', { decision: 'approve' });
      await Promise.allSettled([p1, p2]);
    });
  });
});
