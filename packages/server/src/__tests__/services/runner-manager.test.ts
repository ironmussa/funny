/**
 * Unit tests for runner-manager service — registration, heartbeat,
 * tenant-scoped resolution, tasks, and lifecycle helpers.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  seedProject,
  seedRunner,
  seedRunnerProjectAssignment,
  seedRunnerTask,
} from '../helpers/test-db.js';

describe('runner-manager service', () => {
  let t: TestApp;
  let rm: typeof import('../../services/runner-manager.js');

  beforeAll(async () => {
    t = await createTestApp();
    rm = await import('../../services/runner-manager.js');
  });

  beforeEach(() => {
    t.cleanup();
  });

  describe('registerRunner', () => {
    test('creates a new runner with token', async () => {
      const result = await rm.registerRunner(
        { name: 'Laptop', hostname: 'dev.local', os: 'linux' },
        'user-1',
      );
      expect(result.runnerId).toBeTruthy();
      expect(result.token).toMatch(/^runner_/);

      const runner = await rm.getRunner(result.runnerId);
      expect(runner?.name).toBe('Laptop');
      expect(await rm.getRunnerUserId(result.runnerId)).toBe('user-1');
    });

    test('reuses runner with same hostname for the same user', async () => {
      const first = await rm.registerRunner(
        { name: 'A', hostname: 'same.host', os: 'linux' },
        'user-1',
      );
      const second = await rm.registerRunner(
        { name: 'B', hostname: 'same.host', os: 'linux' },
        'user-1',
      );
      expect(second.runnerId).toBe(first.runnerId);
      expect(second.token).toBe(first.token);
    });

    test('backfills userId on legacy runner without owner', async () => {
      seedRunner(t.db as any, {
        id: 'legacy-r',
        userId: null,
        hostname: 'legacy.host',
        token: 'tok-legacy',
      });

      await rm.registerRunner({ name: 'Backfill', hostname: 'legacy.host', os: 'linux' }, 'user-1');
      expect(await rm.getRunnerUserId('legacy-r')).toBe('user-1');
    });
  });

  describe('authenticateRunner', () => {
    test('returns runnerId for valid token', async () => {
      seedRunner(t.db as any, { id: 'r-auth', token: 'runner_valid', userId: 'user-1' });
      expect(await rm.authenticateRunner('runner_valid')).toBe('r-auth');
    });

    test('returns null for unknown token', async () => {
      expect(await rm.authenticateRunner('runner_unknown')).toBeNull();
    });
  });

  describe('handleHeartbeat', () => {
    test('marks runner busy when active threads are present', async () => {
      seedRunner(t.db as any, { id: 'r-hb', token: 'tok-hb', userId: 'user-1', status: 'online' });

      const ok = await rm.handleHeartbeat('r-hb', { activeThreadIds: ['t1', 't2'] });
      expect(ok).toBe(true);

      const runner = await rm.getRunner('r-hb');
      expect(runner?.status).toBe('busy');
      expect(runner?.activeThreadCount).toBe(2);
    });

    test('returns false when runner no longer exists', async () => {
      expect(await rm.handleHeartbeat('missing', { activeThreadIds: [] })).toBe(false);
    });
  });

  describe('findAnyRunnerForUser', () => {
    test('returns null for user with no runners', async () => {
      expect(await rm.findAnyRunnerForUser('nobody')).toBeNull();
    });

    test('returns null when all runners are stale/offline', async () => {
      seedRunner(t.db as any, {
        id: 'r-off',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: '2020-01-01T00:00:00.000Z',
      });
      expect(await rm.findAnyRunnerForUser('user-1')).toBeNull();
    });

    test('does not return another users runner', async () => {
      seedRunner(t.db as any, {
        id: 'r-other',
        userId: 'user-2',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });
      expect(await rm.findAnyRunnerForUser('user-1')).toBeNull();
    });

    test('prefers online runner with fewer active threads', async () => {
      const now = new Date().toISOString();
      seedRunner(t.db as any, {
        id: 'r-busy',
        userId: 'user-1',
        token: 'tok-busy',
        status: 'busy',
        activeThreadIds: '["t1","t2"]',
        lastHeartbeatAt: now,
      });
      seedRunner(t.db as any, {
        id: 'r-idle',
        userId: 'user-1',
        token: 'tok-idle',
        status: 'online',
        activeThreadIds: '[]',
        lastHeartbeatAt: now,
      });

      expect(await rm.findAnyRunnerForUser('user-1')).toBe('r-idle');
    });
  });

  describe('findRunnerForProject', () => {
    test('returns assignment for online runner owned by user', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedRunner(t.db as any, {
        id: 'r1',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });
      seedRunnerProjectAssignment(t.db as any, {
        runnerId: 'r1',
        projectId: 'p1',
        localPath: '/home/user/p1',
      });

      const resolved = await rm.findRunnerForProject('p1', 'user-1');
      expect(resolved?.runner.runnerId).toBe('r1');
      expect(resolved?.localPath).toBe('/home/user/p1');
    });

    test('returns null for cross-tenant project assignment', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedRunner(t.db as any, {
        id: 'r1',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });
      seedRunnerProjectAssignment(t.db as any, {
        runnerId: 'r1',
        projectId: 'p1',
        localPath: '/a',
      });

      expect(await rm.findRunnerForProject('p1', 'user-2')).toBeNull();
    });
  });

  describe('runner tasks', () => {
    test('createRunnerTask → getPendingTasks → completeTask', async () => {
      seedRunner(t.db as any, { id: 'r-task', userId: 'user-1', token: 'tok-task' });

      const created = await rm.createRunnerTask('r-task', 't1', 'start_agent', { threadId: 't1' });
      expect(created.taskId).toBeTruthy();

      const pending = await rm.getPendingTasks('r-task');
      expect(pending).toHaveLength(1);
      expect(pending[0]?.taskId).toBe(created.taskId);

      await rm.completeTask({ taskId: created.taskId, success: true, data: { ok: true } });

      const schema = t.schema;
      const row = await t.db
        .select({ status: schema.runnerTasks.status })
        .from(schema.runnerTasks)
        .where(eq(schema.runnerTasks.id, created.taskId))
        .then((rows) => rows[0]);
      expect(row?.status).toBe('completed');
    });
  });

  describe('assignProject', () => {
    test('upserts localPath on conflict', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', token: 'tok-1' });
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      await rm.assignProject('r1', { projectId: 'p1', localPath: '/old' });
      const updated = await rm.assignProject('r1', { projectId: 'p1', localPath: '/new' });

      expect(updated.localPath).toBe('/new');
      expect((await rm.listAssignments('r1'))[0]?.localPath).toBe('/new');
    });
  });

  describe('removeRunnerForUser', () => {
    test('deletes only when user owns the runner', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', token: 'tok-1' });

      expect(await rm.removeRunnerForUser('r1', 'user-2')).toBe(false);
      expect(await rm.getRunner('r1')).not.toBeNull();

      expect(await rm.removeRunnerForUser('r1', 'user-1')).toBe(true);
      expect(await rm.getRunner('r1')).toBeNull();
    });
  });

  describe('purgeOfflineRunners', () => {
    test('removes stale offline runners', async () => {
      seedRunner(t.db as any, {
        id: 'stale-off',
        userId: 'user-1',
        status: 'offline',
        lastHeartbeatAt: '2020-01-01T00:00:00.000Z',
      });

      const purged = await rm.purgeOfflineRunners(60_000);
      expect(purged).toBe(1);
      expect(await rm.getRunner('stale-off')).toBeNull();
    });
  });

  describe('markRunnerOffline', () => {
    test('sets runner status to offline', async () => {
      seedRunner(t.db as any, {
        id: 'r-live',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });

      await rm.markRunnerOffline('r-live');
      expect((await rm.getRunner('r-live'))?.status).toBe('offline');
    });
  });

  describe('listRunnersByUser', () => {
    test('returns only runners owned by the user', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', name: 'Mine', token: 't1' });
      seedRunner(t.db as any, { id: 'r2', userId: 'user-2', name: 'Theirs', token: 't2' });

      const rows = await rm.listRunnersByUser('user-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('Mine');
    });
  });
});
