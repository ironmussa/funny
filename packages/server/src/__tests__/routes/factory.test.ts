import { beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { createFactoryRoutes } from '../../routes/factory.js';
import { createTestDb, seedProject, seedProjectMember } from '../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;

beforeEach(async () => {
  testDb = createTestDb();
  const { setConnection } = await import('../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  seedProject(testDb.db, { id: 'bob-project', userId: 'bob', path: '/tmp/bob' });
});

const app = (userId = 'alice') => {
  const root = new Hono<ServerEnv>();
  root.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  root.route('/api/factory', createFactoryRoutes());
  return root;
};

const get = (path: string, userId = 'alice') => app(userId).request(`/api/factory${path}`);
const put = (path: string, body: unknown, userId = 'alice') =>
  app(userId).request(`/api/factory${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('factory routes', () => {
  test('GET answers null until configured, PUT saves, GET reads it back', async () => {
    expect(await (await get('/projects/p1')).json()).toEqual({ settings: null });

    const saved = await put('/projects/p1', { enabled: true, label: 'ready', maxConcurrent: 3 });
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toMatchObject({
      enabled: true,
      label: 'ready',
      maxConcurrent: 3,
    });

    const read = await (await get('/projects/p1')).json();
    expect(read.settings).toMatchObject({ enabled: true, label: 'ready' });
  });

  test('runs is empty until a factory exists, then lists none', async () => {
    expect(await (await get('/projects/p1/runs')).json()).toEqual({ runs: [] });
    await put('/projects/p1', { enabled: true });
    expect(await (await get('/projects/p1/runs')).json()).toEqual({ runs: [] });
  });

  test('a member may configure; a non-member gets 404', async () => {
    seedProjectMember(testDb.db, { projectId: 'bob-project', userId: 'alice', role: 'member' });
    expect((await put('/projects/bob-project', { enabled: true })).status).toBe(200);
    expect((await put('/projects/p1', { enabled: true }, 'carol')).status).toBe(404);
    expect((await get('/projects/p1', 'carol')).status).toBe(404);
  });

  test('rejects a malformed body and an out-of-range concurrency', async () => {
    expect((await put('/projects/p1', {})).status).toBe(400);
    expect((await put('/projects/p1', { enabled: true, maxConcurrent: 99 })).status).toBe(400);
    expect((await put('/projects/p1', { enabled: true, label: '' })).status).toBe(400);
  });
});
