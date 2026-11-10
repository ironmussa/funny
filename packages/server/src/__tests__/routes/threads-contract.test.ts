/**
 * `/api/threads` responses follow the shared contract
 * (`@funny/shared/contracts/threads`), not the raw `threads` row: booleans
 * instead of 0/1, `''` for a scratch thread's project, optional fields absent
 * instead of null, and server-internal columns left out.
 */

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedThread } from '../helpers/test-db.js';

/** Columns the server keeps to itself; the detail view exposes `initInfo` instead. */
const INTERNAL_COLUMNS = ['initTools', 'initCwd', 'initSlashCommands', 'runnerId', 'mergedAt'];

describe('Thread routes follow the contract', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
  });

  describe('thread shape', () => {
    test('a listed thread has boolean flags and no null fields', async () => {
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        pinned: 1,
        schedulerManaged: 0,
        mergedAt: '2026-11-01T00:00:00.000Z',
      });

      const res = await t.requestAs('user-1').get('/api/threads?projectId=p1');
      expect(res.status).toBe(200);
      const [thread] = (await res.json()).threads;

      expect(thread).toMatchObject({
        id: 't1',
        projectId: 'p1',
        isScratch: false,
        archived: false,
        pinned: true,
        schedulerManaged: false,
        fileCheckpointingEnabled: false,
        commentCount: 0,
      });
      expect(thread).not.toHaveProperty('branch');
      expect(thread).not.toHaveProperty('completedAt');
      for (const column of INTERNAL_COLUMNS) expect(thread).not.toHaveProperty(column);
      // `contextRecoveryReason` and the agent-profile fields are declared nullable.
      const nullable = [
        'contextRecoveryReason',
        'agentProfileId',
        'agentProfileName',
        'agentProfileProvider',
      ];
      for (const [key, value] of Object.entries(thread)) {
        if (!nullable.includes(key)) expect({ key, value }).not.toEqual({ key, value: null });
      }
    });

    test('a scratch thread has an empty projectId, not null', async () => {
      seedThread(t.db as any, { id: 's1', projectId: null, userId: 'user-1', isScratch: 1 });

      const res = await t.requestAs('user-1').get('/api/threads/scratch');
      const [thread] = (await res.json()).threads;
      expect(thread).toMatchObject({ id: 's1', projectId: '', isScratch: true });
    });

    test('template variables arrive parsed, not as JSON text', async () => {
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        templateVariables: JSON.stringify({ ticket: 'ABC-1' }),
      });

      const res = await t.requestAs('user-1').get('/api/threads/t1');
      expect((await res.json()).templateVariables).toEqual({ ticket: 'ABC-1' });
    });

    test('the detail view keeps its message window and initInfo, without the raw init columns', async () => {
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        archived: 1,
        initTools: JSON.stringify(['Read']),
        initCwd: '/a',
        initSlashCommands: JSON.stringify(['/review']),
      });

      const res = await t.requestAs('user-1').get('/api/threads/t1');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.archived).toBe(true);
      expect(body.messages).toEqual([]);
      expect(body.initInfo).toMatchObject({
        tools: ['Read'],
        cwd: '/a',
        slashCommands: ['/review'],
      });
      expect(body.viewerShareLevel).toBeNull();
      for (const column of INTERNAL_COLUMNS) expect(body).not.toHaveProperty(column);
    });

    test('an archived listing maps its threads too', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1', archived: 1 });

      const res = await t.requestAs('user-1').get('/api/threads/archived');
      const body = await res.json();
      expect(body).toMatchObject({ total: 1, page: 1, limit: 100 });
      expect(body.threads[0].archived).toBe(true);
    });
  });

  describe('list paging', () => {
    test('clamps an out-of-range limit instead of refusing it', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').get('/api/threads?projectId=p1&limit=5000&offset=-3');
      expect(res.status).toBe(200);
      expect((await res.json()).threads).toHaveLength(1);
    });

    test('falls back to the default page size for an unparsable limit', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').get('/api/threads?projectId=p1&limit=lots');
      expect(res.status).toBe(200);
      expect((await res.json()).threads).toHaveLength(1);
    });
  });

  describe('PATCH /api/threads/:id body', () => {
    test('refuses a value of the wrong type instead of writing it', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1', title: 'Original' });

      for (const body of [
        { title: 123 },
        { archived: 'yes' },
        { status: 'not-a-status' },
        { mode: 'elsewhere' },
      ]) {
        const res = await t.requestAs('user-1').patch('/api/threads/t1', body);
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }

      const [row] = await t.db.select().from(t.schema.threads).where(eq(t.schema.threads.id, 't1'));
      expect(row).toMatchObject({ title: 'Original', archived: 0, status: 'pending' });
    });

    test('still ignores keys outside the allow-list', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t
        .requestAs('user-1')
        .patch('/api/threads/t1', { title: 'Renamed', userId: 'user-2', cost: 99 });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ title: 'Renamed', userId: 'user-1', cost: 0 });
    });

    test('answers 404 for someone else’s thread before looking at the body', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1', { title: 123 });
      expect(res.status).toBe(404);
    });
  });
});
