/**
 * Unit tests for runner-manager service — registration, heartbeat,
 * tenant-scoped resolution, tasks, and lifecycle helpers.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import { buildStartAgentPayload, seedDbFor } from '../helpers/builders-services.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedRunner, seedRunnerProjectAssignment } from '../helpers/test-db.js';

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
      seedRunner(seedDbFor(t.db), {
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
      seedRunner(seedDbFor(t.db), { id: 'r-auth', token: 'runner_valid', userId: 'user-1' });
      expect(await rm.authenticateRunner('runner_valid')).toBe('r-auth');
    });

    test('returns null for unknown token', async () => {
      expect(await rm.authenticateRunner('runner_unknown')).toBeNull();
    });
  });

  describe('handleHeartbeat', () => {
    test('marks runner busy when active threads are present', async () => {
      seedRunner(seedDbFor(t.db), {
        id: 'r-hb',
        token: 'tok-hb',
        userId: 'user-1',
        status: 'online',
      });

      const ok = await rm.handleHeartbeat('r-hb', { activeThreadIds: ['t1', 't2'] });
      expect(ok).toBe(true);

      const runner = await rm.getRunner('r-hb');
      expect(runner?.status).toBe('busy');
      expect(runner?.activeThreadCount).toBe(2);
    });

    test('does not bring back a runner whose gRPC session dropped', async () => {
      seedRunner(seedDbFor(t.db), {
        id: 'r-gone',
        token: 'tok-gone',
        userId: 'user-1',
        status: 'online',
      });
      await rm.markRunnerOffline('r-gone');

      expect(await rm.handleHeartbeat('r-gone', { activeThreadIds: ['t1'] })).toBe(true);

      const runner = await rm.getRunner('r-gone');
      expect(runner?.status).toBe('offline');
      expect(runner?.activeThreadCount).toBe(1);
      expect(await rm.findAnyRunnerForUser('user-1')).toBeNull();
    });

    test('returns false when runner no longer exists', async () => {
      expect(await rm.handleHeartbeat('missing', { activeThreadIds: [] })).toBe(false);
    });

    test('caches providers advertised on heartbeat', async () => {
      seedRunner(seedDbFor(t.db), {
        id: 'r-adv',
        token: 'tok-adv',
        userId: 'user-1',
        status: 'online',
      });
      const provider = {
        id: 'myagent-ext',
        label: 'My Agent',
        models: { kind: 'dynamic' as const, defaultModel: 'default' },
        attachmentLimits: { inlineMaxBytes: 1, uploadMaxBytes: 2, hardMaxBytes: 3 },
        auth: { mode: 'runner-preauth' as const },
      };

      await rm.handleHeartbeat('r-adv', { activeThreadIds: [], providers: [provider] });
      expect(rm.getAdvertisedProviders('r-adv').map((p) => p.id)).toEqual(['myagent-ext']);

      // The user sees their runner's advertised providers.
      expect((await rm.getAdvertisedProvidersForUser('user-1')).map((p) => p.id)).toContain(
        'myagent-ext',
      );

      // An empty advertisement clears them.
      await rm.handleHeartbeat('r-adv', { activeThreadIds: [], providers: [] });
      expect(rm.getAdvertisedProviders('r-adv')).toEqual([]);
    });

    test('caches the active built-in set advertised on heartbeat (lean-core)', async () => {
      seedRunner(seedDbFor(t.db), {
        id: 'r-lc',
        token: 'tok-lc',
        userId: 'user-lc',
        status: 'online',
      });

      // Unknown until advertised → null (client must not filter the picker).
      expect(await rm.getActiveBuiltinsForUser('user-lc')).toBeNull();

      await rm.handleHeartbeat('r-lc', {
        activeThreadIds: [],
        activeBuiltins: ['codex', 'gemini'],
      });
      expect(await rm.getActiveBuiltinsForUser('user-lc')).toEqual(['codex', 'gemini']);

      // An explicit empty set is distinct from "unknown" → filter to none.
      await rm.handleHeartbeat('r-lc', { activeThreadIds: [], activeBuiltins: [] });
      expect(await rm.getActiveBuiltinsForUser('user-lc')).toEqual([]);
    });

    test('caches the available-provider set advertised on heartbeat (model-picker-availability)', async () => {
      seedRunner(seedDbFor(t.db), {
        id: 'r-av',
        token: 'tok-av',
        userId: 'user-av',
        status: 'online',
      });

      // No runner advertisement yet → null (client must not gate / shows no-runner).
      expect(await rm.getAvailableProvidersForUser('user-av')).toBeNull();

      await rm.handleHeartbeat('r-av', {
        activeThreadIds: [],
        availableProviders: ['claude', 'codex'],
      });
      expect(await rm.getAvailableProvidersForUser('user-av')).toEqual(['claude', 'codex']);

      // Runner online but nothing available is distinct from "unknown".
      await rm.handleHeartbeat('r-av', { activeThreadIds: [], availableProviders: [] });
      expect(await rm.getAvailableProvidersForUser('user-av')).toEqual([]);
    });

    test('no runner for the user → availability is null (no-runner state)', async () => {
      expect(await rm.getAvailableProvidersForUser('nobody-home')).toBeNull();
    });
  });

  describe('findAnyRunnerForUser', () => {
    test('returns null for user with no runners', async () => {
      expect(await rm.findAnyRunnerForUser('nobody')).toBeNull();
    });

    test('returns null when all runners are stale/offline', async () => {
      seedRunner(seedDbFor(t.db), {
        id: 'r-off',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: '2020-01-01T00:00:00.000Z',
      });
      expect(await rm.findAnyRunnerForUser('user-1')).toBeNull();
    });

    test('does not return another users runner', async () => {
      seedRunner(seedDbFor(t.db), {
        id: 'r-other',
        userId: 'user-2',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });
      expect(await rm.findAnyRunnerForUser('user-1')).toBeNull();
    });

    test('prefers online runner with fewer active threads', async () => {
      const now = new Date().toISOString();
      seedRunner(seedDbFor(t.db), {
        id: 'r-busy',
        userId: 'user-1',
        token: 'tok-busy',
        status: 'busy',
        activeThreadIds: '["t1","t2"]',
        lastHeartbeatAt: now,
      });
      seedRunner(seedDbFor(t.db), {
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
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/a' });
      seedRunner(seedDbFor(t.db), {
        id: 'r1',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });
      seedRunnerProjectAssignment(seedDbFor(t.db), {
        runnerId: 'r1',
        projectId: 'p1',
        localPath: '/home/user/p1',
      });

      const resolved = await rm.findRunnerForProject('p1', 'user-1');
      expect(resolved?.runner.runnerId).toBe('r1');
      expect(resolved?.localPath).toBe('/home/user/p1');
    });

    test('returns null for cross-tenant project assignment', async () => {
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/a' });
      seedRunner(seedDbFor(t.db), {
        id: 'r1',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });
      seedRunnerProjectAssignment(seedDbFor(t.db), {
        runnerId: 'r1',
        projectId: 'p1',
        localPath: '/a',
      });

      expect(await rm.findRunnerForProject('p1', 'user-2')).toBeNull();
    });

    test('orphaned project (no assignment row) falls back to the owner online runner', async () => {
      // Regression: a project created after the runner advertised its project
      // list has no runner_project_assignments row. Without the fallback,
      // findRunnerForProject returned null and the terminal failed with
      // "No runner available to handle terminal request" even though the
      // user's runner was online.
      seedProject(seedDbFor(t.db), { id: 'orphan', userId: 'user-1', path: '/home/user/orphan' });
      seedRunner(seedDbFor(t.db), {
        id: 'r1',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });

      const resolved = await rm.findRunnerForProject('orphan', 'user-1');
      expect(resolved?.runner.runnerId).toBe('r1');
      // Uses the project's stored path as the local cwd.
      expect(resolved?.localPath).toBe('/home/user/orphan');
    });

    test('orphaned project fallback never crosses tenants', async () => {
      // The online runner belongs to user-2; user-1 owns the project. The
      // fallback must NOT route user-1's terminal onto user-2's runner.
      seedProject(seedDbFor(t.db), { id: 'orphan', userId: 'user-1', path: '/home/user/orphan' });
      seedRunner(seedDbFor(t.db), {
        id: 'r-other',
        userId: 'user-2',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });

      expect(await rm.findRunnerForProject('orphan', 'user-1')).toBeNull();
    });

    test('orphaned project fallback returns null when the user has no online runner', async () => {
      seedProject(seedDbFor(t.db), { id: 'orphan', userId: 'user-1', path: '/home/user/orphan' });
      seedRunner(seedDbFor(t.db), {
        id: 'r-stale',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: '2020-01-01T00:00:00.000Z',
      });

      expect(await rm.findRunnerForProject('orphan', 'user-1')).toBeNull();
    });
  });

  describe('runner tasks', () => {
    test('two polls at once hand a task to only one of them', async () => {
      seedRunner(seedDbFor(t.db), { id: 'r-race', userId: 'user-1', token: 'tok-race' });
      await rm.createRunnerTask('r-race', 't1', 'start_agent', buildStartAgentPayload());

      const polls = await Promise.all([rm.getPendingTasks('r-race'), rm.getPendingTasks('r-race')]);
      expect(polls.map((p) => p.length).sort()).toEqual([0, 1]);
    });

    test('a task that has a result keeps it', async () => {
      seedRunner(seedDbFor(t.db), { id: 'r-done', userId: 'user-1', token: 'tok-done' });
      const task = await rm.createRunnerTask(
        'r-done',
        't1',
        'start_agent',
        buildStartAgentPayload(),
      );
      await rm.getPendingTasks('r-done');
      expect(await rm.completeTask('r-done', { taskId: task.taskId, success: true })).toBe(true);
      expect(await rm.completeTask('r-done', { taskId: task.taskId, success: false })).toBe(false);
    });

    test('createRunnerTask → getPendingTasks → completeTask', async () => {
      seedRunner(seedDbFor(t.db), { id: 'r-task', userId: 'user-1', token: 'tok-task' });

      const created = await rm.createRunnerTask(
        'r-task',
        't1',
        'start_agent',
        buildStartAgentPayload(),
      );
      expect(created.taskId).toBeTruthy();

      const pending = await rm.getPendingTasks('r-task');
      expect(pending).toHaveLength(1);
      expect(pending[0]?.taskId).toBe(created.taskId);

      expect(
        await rm.completeTask('r-task', {
          taskId: created.taskId,
          success: true,
          data: { ok: true },
        }),
      ).toBe(true);

      const schema = t.schema;
      const row = await t.db
        .select({ status: schema.runnerTasks.status })
        .from(schema.runnerTasks)
        .where(eq(schema.runnerTasks.id, created.taskId))
        .then((rows) => rows[0]);
      expect(row?.status).toBe('completed');
    });

    test('completeTask refuses a task belonging to another runner', async () => {
      seedRunner(seedDbFor(t.db), { id: 'r-owner', userId: 'user-1', token: 'tok-owner' });
      seedRunner(seedDbFor(t.db), { id: 'r-other', userId: 'user-2', token: 'tok-other' });
      const created = await rm.createRunnerTask(
        'r-owner',
        't1',
        'start_agent',
        buildStartAgentPayload(),
      );

      expect(
        await rm.completeTask('r-other', {
          taskId: created.taskId,
          success: false,
          error: 'forged',
        }),
      ).toBe(false);

      const schema = t.schema;
      const row = await t.db
        .select({ status: schema.runnerTasks.status, error: schema.runnerTasks.resultError })
        .from(schema.runnerTasks)
        .where(eq(schema.runnerTasks.id, created.taskId))
        .then((rows) => rows[0]);
      expect(row?.status).toBe('pending');
      expect(row?.error).toBeNull();
    });
  });

  describe('assignProject', () => {
    test('upserts localPath on conflict', async () => {
      seedRunner(seedDbFor(t.db), { id: 'r1', userId: 'user-1', token: 'tok-1' });
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/a' });

      await rm.assignProject('r1', { projectId: 'p1', localPath: '/old' });
      const updated = await rm.assignProject('r1', { projectId: 'p1', localPath: '/new' });

      expect(updated.localPath).toBe('/new');
      expect((await rm.listAssignments('r1'))[0]?.localPath).toBe('/new');
    });
  });

  describe('removeRunnerForUser', () => {
    test('deletes only when user owns the runner', async () => {
      seedRunner(seedDbFor(t.db), { id: 'r1', userId: 'user-1', token: 'tok-1' });

      expect(await rm.removeRunnerForUser('r1', 'user-2')).toBe(false);
      expect(await rm.getRunner('r1')).not.toBeNull();

      expect(await rm.removeRunnerForUser('r1', 'user-1')).toBe(true);
      expect(await rm.getRunner('r1')).toBeNull();
    });
  });

  describe('purgeOfflineRunners', () => {
    test('removes stale offline runners', async () => {
      seedRunner(seedDbFor(t.db), {
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

  describe('markRunnerOnline', () => {
    test('brings an offline runner back and keeps the load it reported', async () => {
      seedRunner(seedDbFor(t.db), {
        id: 'r-on',
        token: 'tok-on',
        userId: 'user-1',
        status: 'online',
      });
      await rm.handleHeartbeat('r-on', { activeThreadIds: ['t1'] });
      await rm.markRunnerOffline('r-on');

      await rm.markRunnerOnline('r-on');
      expect((await rm.getRunner('r-on'))?.status).toBe('busy');

      await rm.handleHeartbeat('r-on', { activeThreadIds: [] });
      await rm.markRunnerOnline('r-on');
      expect((await rm.getRunner('r-on'))?.status).toBe('online');
    });
  });

  describe('markRunnerOffline', () => {
    test('sets runner status to offline', async () => {
      seedRunner(seedDbFor(t.db), {
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
      seedRunner(seedDbFor(t.db), { id: 'r1', userId: 'user-1', name: 'Mine', token: 't1' });
      seedRunner(seedDbFor(t.db), { id: 'r2', userId: 'user-2', name: 'Theirs', token: 't2' });

      const rows = await rm.listRunnersByUser('user-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('Mine');
    });
  });
});
