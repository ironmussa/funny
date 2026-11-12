/**
 * The `threads` tRPC procedures (openspec adopt-trpc-browser-api, task 4.2):
 * the server-answered reads and field updates, their authorization (owner,
 * sharee, stranger), 404-before-400, realtime events, and parity with the REST
 * routes, which serve the same port while both paths coexist.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { FakeBrowserEventSink } from '../helpers/runner-port-fakes.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedMessage, seedProject, seedThread } from '../helpers/test-db.js';

const headersFor = (userId: string) => ({
  'X-Test-User-Id': userId,
  'Content-Type': 'application/json',
});

describe('threads tRPC procedures', () => {
  let t: TestApp;
  const browserEvents = new FakeBrowserEventSink();

  const query = async (userId: string, path: string, input?: unknown) => {
    const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await t.app.request(`/api/trpc/threads.${path}${qs}`, {
      headers: headersFor(userId),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const mutate = async (userId: string, path: string, input: unknown) => {
    const res = await t.app.request(`/api/trpc/threads.${path}`, {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const shareWithUser2 = async (level: 'view' | 'steer') => {
    const { repos } = await import('../../db/repos.js');
    await repos.threadShares().createShare({
      threadId: 't1',
      sharedWithUserId: 'user-2',
      sharedByUserId: 'user-1',
      level,
    });
  };

  beforeAll(async () => {
    t = await createTestApp({ browserEvents });
  });

  beforeEach(() => {
    t.cleanup();
    browserEvents.deliveries.length = 0;
    browserEvents.publications.length = 0;
    t.db.run(sql`DELETE FROM thread_shares`);
    t.db.run(sql`DELETE FROM resource_grants`);
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/tmp/p1' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1', title: 'First' });
    seedMessage(t.db as any, { id: 'm1', threadId: 't1', role: 'user', content: 'hello world' });
  });

  describe('reads', () => {
    test('list without input reads the defaults and returns only the caller’s threads', async () => {
      seedThread(t.db as any, { id: 't2', projectId: 'p1', userId: 'user-2' });
      const res = await query('user-1', 'list');
      expect(res.status).toBe(200);
      expect(res.body.result.data.threads.map((th: any) => th.id)).toEqual(['t1']);
      expect(res.body.result.data.hasMore).toBe(false);
    });

    test('get returns the detail with messages; a stranger gets 404', async () => {
      const own = await query('user-1', 'get', { id: 't1' });
      expect(own.status).toBe(200);
      expect(own.body.result.data.messages.map((m: any) => m.id)).toEqual(['m1']);
      expect(own.body.result.data.viewerShareLevel).toBeNull();

      const stranger = await query('user-2', 'get', { id: 't1' });
      expect(stranger.status).toBe(404);
      expect(stranger.body.error.message).toBe('Thread not found');
    });

    test('a view sharee can read the thread and its messages, with its share level', async () => {
      await shareWithUser2('view');
      const detail = await query('user-2', 'get', { id: 't1' });
      expect(detail.status).toBe(200);
      expect(detail.body.result.data.viewerShareLevel).toBe('view');

      const messages = await query('user-2', 'messages', { id: 't1', limit: 10 });
      expect(messages.status).toBe(200);
      const search = await query('user-2', 'searchMessages', { id: 't1', q: 'hello' });
      expect(search.body.result.data.results).toHaveLength(1);
    });

    test('messages of another user’s thread answer 404', async () => {
      expect((await query('user-2', 'messages', { id: 't1' })).status).toBe(404);
      expect((await query('user-2', 'searchMessages', { id: 't1', q: 'x' })).status).toBe(404);
    });
  });

  describe('writes', () => {
    test('update renames, records the stage move and broadcasts it', async () => {
      const res = await mutate('user-1', 'update', {
        id: 't1',
        data: { title: 'Renamed', stage: 'review' },
      });
      expect(res.status).toBe(200);
      expect(res.body.result.data).toMatchObject({ id: 't1', title: 'Renamed', stage: 'review' });
      expect(browserEvents.deliveries.at(-1)).toMatchObject({
        target: 'user',
        id: 'user-1',
        event: { type: 'thread:stage-changed', data: { fromStage: 'backlog', toStage: 'review' } },
      });
    });

    test('setPermissionMode persists and broadcasts thread:updated', async () => {
      const res = await mutate('user-1', 'setPermissionMode', { id: 't1', permissionMode: 'plan' });
      expect(res.body.result.data.permissionMode).toBe('plan');
      expect(browserEvents.deliveries.at(-1)).toMatchObject({
        target: 'user',
        event: { type: 'thread:updated', data: { permissionMode: 'plan' } },
      });
    });

    test('a sharee, even at steer level, cannot write (404)', async () => {
      await shareWithUser2('steer');
      expect((await mutate('user-2', 'update', { id: 't1', data: { title: 'x' } })).status).toBe(
        404,
      );
      expect(
        (await mutate('user-2', 'setPermissionMode', { id: 't1', permissionMode: 'plan' })).status,
      ).toBe(404);
      expect((await mutate('user-2', 'setStage', { id: 't1', value: 'done' })).status).toBe(404);
    });

    test('404 wins over invalid input; the owner with invalid input gets 400', async () => {
      const stranger = await mutate('user-2', 'setStatus', { id: 't1', value: 'bogus' });
      expect(stranger.status).toBe(404);

      const owner = await mutate('user-1', 'setStatus', { id: 't1', value: 'bogus' });
      expect(owner.status).toBe(400);
      expect(owner.body.error.message).toContain('Invalid status "bogus"');
    });

    test('worktreePath is not writable (Security CR-4)', async () => {
      await mutate('user-1', 'update', { id: 't1', data: { worktreePath: '/etc' } });
      const detail = await query('user-1', 'get', { id: 't1' });
      expect(detail.body.result.data.worktreePath).not.toBe('/etc');
    });
  });

  describe('parity with REST', () => {
    test('reads return the same data on both paths', async () => {
      const rest = t.requestAs('user-1');
      const pairs: Array<[string, string, unknown]> = [
        ['/api/threads?projectId=p1', 'list', { projectId: 'p1' }],
        ['/api/threads/scratch', 'scratch', undefined],
        ['/api/threads/archived', 'archived', undefined],
        ['/api/threads/t1', 'get', { id: 't1' }],
        ['/api/threads/t1/messages?limit=10', 'messages', { id: 't1', limit: 10 }],
        ['/api/threads/t1/messages/search?q=hello', 'searchMessages', { id: 't1', q: 'hello' }],
        ['/api/threads/search/content?q=hello', 'searchContent', { q: 'hello' }],
      ];
      for (const [restPath, procedure, input] of pairs) {
        const restRes = await rest.get(restPath);
        const trpcRes = await query('user-1', procedure, input);
        expect(trpcRes.status).toBe(restRes.status);
        expect(trpcRes.body.result.data).toEqual(await restRes.json());
      }
    });

    test('a write answers the same thread on both paths', async () => {
      const restRes = await t.requestAs('user-1').patch('/api/threads/t1', { pinned: true });
      const trpcRes = await mutate('user-1', 'update', { id: 't1', data: { pinned: true } });
      // The second write moves updatedAt; everything else is the same thread.
      const restThread = await restRes.json();
      expect(trpcRes.body.result.data).toEqual({ ...restThread, updatedAt: expect.any(String) });
    });
  });
});
