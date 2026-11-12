/**
 * The `designs`, `analytics` and `push` tRPC procedures (openspec
 * adopt-trpc-browser-api, task 5.5): project and owner gates and validation.
 * The REST routes are gone (task 6.1).
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject } from '../helpers/test-db.js';

const headersFor = (userId: string) => ({
  'X-Test-User-Id': userId,
  'Content-Type': 'application/json',
});

describe('designs, analytics and push over tRPC', () => {
  let t: TestApp;

  const query = async (userId: string, path: string, input?: unknown) => {
    const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await t.app.request(`/api/trpc/${path}${qs}`, { headers: headersFor(userId) });
    return { status: res.status, body: (await res.json()) as any };
  };

  const mutate = async (userId: string, path: string, input: unknown) => {
    const res = await t.app.request(`/api/trpc/${path}`, {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'owner', path: '/tmp/p1' });
  });

  describe('designs', () => {
    test('create and list need access to the project, checked before validation', async () => {
      const stranger = await mutate('intruder', 'designs.create', {
        projectId: 'p1',
        name: '',
        type: 'nope',
      });
      expect(stranger.status).toBe(404);
      expect((await query('intruder', 'designs.list', { projectId: 'p1' })).status).toBe(404);

      const invalid = await mutate('owner', 'designs.create', {
        projectId: 'p1',
        name: 'Deck',
        type: 'nope',
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.message).toBe(
        'type must be one of: prototype, slides, template, other',
      );

      const created = await mutate('owner', 'designs.create', {
        projectId: 'p1',
        name: '  Deck  ',
        type: 'slides',
      });
      expect(created.body.result.data).toMatchObject({
        name: 'Deck',
        type: 'slides',
        fidelity: null,
        speakerNotes: false,
      });
      expect(created.body.result.data.folderPath).toBe(`designs/${created.body.result.data.id}`);
      expect(
        (await query('owner', 'designs.list', { projectId: 'p1' })).body.result.data,
      ).toHaveLength(1);
    });

    test('a design is its owner’s only: 404 missing, 403 someone else’s', async () => {
      const created = await mutate('owner', 'designs.create', {
        projectId: 'p1',
        name: 'Proto',
        type: 'prototype',
      });
      const id = created.body.result.data.id;

      expect((await query('intruder', 'designs.get', { id })).status).toBe(403);
      expect((await mutate('intruder', 'designs.remove', { id })).status).toBe(403);
      expect((await query('owner', 'designs.get', { id: 'missing' })).status).toBe(404);

      const trpc = await query('owner', 'designs.get', { id });
      expect(trpc.body.result.data).toMatchObject({ id, name: 'Proto', type: 'prototype' });

      expect((await mutate('owner', 'designs.remove', { id })).body.result.data).toEqual({
        ok: true,
      });
      expect((await query('owner', 'designs.get', { id })).status).toBe(404);
    });
  });

  describe('analytics', () => {
    test('overview and timeline answer without input', async () => {
      const overview = await query('owner', 'analytics.overview');
      expect(overview.status).toBe(200);
      expect(overview.body.result.data).toMatchObject({ createdCount: 0, totalCost: 0 });

      const timeline = await query('owner', 'analytics.timeline', { groupBy: 'week', tz: 0 });
      expect(timeline.body.result.data.groupBy).toBe('week');
    });
  });

  describe('push', () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) },
    };

    test('config reports no key when Web Push is not configured; subscribe answers 503', async () => {
      expect((await query('owner', 'push.config')).body.result.data).toEqual({ publicKey: null });
      const res = await mutate('owner', 'push.subscribe', subscription);
      expect(res.status).toBe(503);
      expect(res.body.error.message).toBe('Web Push is not configured on the server');
    });

    test('a subscription to a non-push endpoint is refused', async () => {
      const res = await mutate('owner', 'push.subscribe', {
        ...subscription,
        endpoint: 'https://evil.example/collect',
      });
      expect(res.status).toBe(400);
    });
  });
});
