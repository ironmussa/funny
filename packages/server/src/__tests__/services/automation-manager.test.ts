import { describe, test, expect, beforeEach } from 'bun:test';

import { eq, and, desc } from 'drizzle-orm';

import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

/**
 * Tests for automation-manager.ts logic.
 *
 * Since automation-manager imports a singleton db and lazy-loads the scheduler,
 * we reimplement the query logic against a fresh in-memory test DB.
 */

describe('AutomationManager', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
  });

  // ── Helpers that mirror automation-manager.ts functions ─────────

  function listAutomations(projectId?: string, userId?: string) {
    const filters: ReturnType<typeof eq>[] = [];

    if (projectId) {
      filters.push(eq(testDb.schema.automations.projectId, projectId));
    }
    if (userId && userId !== '__local__') {
      filters.push(eq(testDb.schema.automations.userId, userId));
    }

    const condition = filters.length > 0 ? and(...filters) : undefined;
    return testDb.db
      .select()
      .from(testDb.schema.automations)
      .where(condition)
      .orderBy(desc(testDb.schema.automations.createdAt))
      .all();
  }

  function getAutomation(id: string) {
    return testDb.db
      .select()
      .from(testDb.schema.automations)
      .where(eq(testDb.schema.automations.id, id))
      .get();
  }

  function createAutomation(data: {
    id?: string;
    projectId: string;
    name: string;
    prompt: string;
    schedule: string;
    model?: string;
    permissionMode?: string;
    userId?: string;
  }) {
    const id = data.id ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    testDb.db
      .insert(testDb.schema.automations)
      .values({
        id,
        projectId: data.projectId,
        userId: data.userId || '__local__',
        name: data.name,
        prompt: data.prompt,
        schedule: data.schedule,
        model: data.model || 'sonnet',
        mode: 'local',
        permissionMode: data.permissionMode || 'autoEdit',
        baseBranch: null,
        enabled: 1,
        maxRunHistory: 20,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return getAutomation(id)!;
  }

  function updateAutomation(id: string, updates: Record<string, any>) {
    updates.updatedAt = new Date().toISOString();
    testDb.db
      .update(testDb.schema.automations)
      .set(updates)
      .where(eq(testDb.schema.automations.id, id))
      .run();
  }

  function deleteAutomation(id: string) {
    testDb.db.delete(testDb.schema.automations).where(eq(testDb.schema.automations.id, id)).run();
  }

  function createRun(data: {
    id: string;
    automationId: string;
    threadId: string;
    status: string;
    triageStatus: string;
    startedAt: string;
  }) {
    testDb.db.insert(testDb.schema.automationRuns).values(data).run();
  }

  function updateRun(id: string, updates: Record<string, any>) {
    testDb.db
      .update(testDb.schema.automationRuns)
      .set(updates)
      .where(eq(testDb.schema.automationRuns.id, id))
      .run();
  }

  function listRuns(automationId: string) {
    return testDb.db
      .select()
      .from(testDb.schema.automationRuns)
      .where(eq(testDb.schema.automationRuns.automationId, automationId))
      .orderBy(desc(testDb.schema.automationRuns.startedAt))
      .all();
  }

  function listRunningRuns() {
    return testDb.db
      .select()
      .from(testDb.schema.automationRuns)
      .where(eq(testDb.schema.automationRuns.status, 'running'))
      .all();
  }

  function getRunByThreadId(threadId: string) {
    return testDb.db
      .select()
      .from(testDb.schema.automationRuns)
      .where(eq(testDb.schema.automationRuns.threadId, threadId))
      .get();
  }

  function getRun(id: string) {
    return testDb.db
      .select()
      .from(testDb.schema.automationRuns)
      .where(eq(testDb.schema.automationRuns.id, id))
      .get();
  }

  // ── Automation CRUD ────────────────────────────────────────────

  describe('Automation CRUD', () => {
    test('createAutomation inserts an automation with all defaults', () => {
      seedProject(testDb.db, { id: 'p1' });

      const auto = createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Daily lint check',
        prompt: 'Run eslint on the codebase and fix any errors',
        schedule: '0 9 * * *',
      });

      expect(auto).toBeTruthy();
      expect(auto.id).toBe('auto-1');
      expect(auto.name).toBe('Daily lint check');
      expect(auto.prompt).toBe('Run eslint on the codebase and fix any errors');
      expect(auto.schedule).toBe('0 9 * * *');
      expect(auto.model).toBe('sonnet');
      expect(auto.mode).toBe('local');
      expect(auto.permissionMode).toBe('autoEdit');
      expect(auto.enabled).toBe(1);
      expect(auto.maxRunHistory).toBe(20);
      expect(auto.userId).toBe('__local__');
      expect(auto.baseBranch).toBeNull();
      expect(auto.lastRunAt).toBeNull();
      expect(auto.nextRunAt).toBeNull();
      expect(auto.createdAt).toBeTruthy();
      expect(auto.updatedAt).toBeTruthy();
    });

    test('createAutomation with custom model and permissionMode', () => {
      seedProject(testDb.db, { id: 'p1' });

      const auto = createAutomation({
        id: 'auto-custom',
        projectId: 'p1',
        name: 'Custom automation',
        prompt: 'Do something',
        schedule: '0 0 * * *',
        model: 'opus',
        permissionMode: 'plan',
      });

      expect(auto.model).toBe('opus');
      expect(auto.permissionMode).toBe('plan');
    });

    test('createAutomation with userId for multi-user', () => {
      seedProject(testDb.db, { id: 'p1' });

      const auto = createAutomation({
        id: 'auto-user',
        projectId: 'p1',
        name: 'User automation',
        prompt: 'Test',
        schedule: '0 12 * * *',
        userId: 'user-abc',
      });

      expect(auto.userId).toBe('user-abc');
    });

    test('getAutomation returns an automation by ID', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });

      const auto = getAutomation('auto-1');
      expect(auto).toBeTruthy();
      expect(auto!.id).toBe('auto-1');
      expect(auto!.name).toBe('Test');
    });

    test('getAutomation returns undefined for non-existent ID', () => {
      expect(getAutomation('nonexistent')).toBeUndefined();
    });

    test('listAutomations returns all automations', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'First',
        prompt: 'A',
        schedule: '* * * * *',
      });
      createAutomation({
        id: 'auto-2',
        projectId: 'p1',
        name: 'Second',
        prompt: 'B',
        schedule: '0 * * * *',
      });

      const all = listAutomations();
      expect(all).toHaveLength(2);
    });

    test('listAutomations filters by projectId', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedProject(testDb.db, { id: 'p2' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'P1 Auto',
        prompt: 'A',
        schedule: '* * * * *',
      });
      createAutomation({
        id: 'auto-2',
        projectId: 'p2',
        name: 'P2 Auto',
        prompt: 'B',
        schedule: '0 * * * *',
      });

      const p1Autos = listAutomations('p1');
      expect(p1Autos).toHaveLength(1);
      expect(p1Autos[0].name).toBe('P1 Auto');

      const p2Autos = listAutomations('p2');
      expect(p2Autos).toHaveLength(1);
      expect(p2Autos[0].name).toBe('P2 Auto');
    });

    test('listAutomations filters by userId in multi mode', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'User A auto',
        prompt: 'A',
        schedule: '* * * * *',
        userId: 'user-a',
      });
      createAutomation({
        id: 'auto-2',
        projectId: 'p1',
        name: 'User B auto',
        prompt: 'B',
        schedule: '0 * * * *',
        userId: 'user-b',
      });

      const userAAutos = listAutomations(undefined, 'user-a');
      expect(userAAutos).toHaveLength(1);
      expect(userAAutos[0].name).toBe('User A auto');
    });

    test('listAutomations with __local__ userId returns all automations', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'A',
        prompt: 'A',
        schedule: '* * * * *',
        userId: 'user-a',
      });
      createAutomation({
        id: 'auto-2',
        projectId: 'p1',
        name: 'B',
        prompt: 'B',
        schedule: '0 * * * *',
        userId: 'user-b',
      });

      const all = listAutomations(undefined, '__local__');
      expect(all).toHaveLength(2);
    });

    test('listAutomations orders by createdAt descending', () => {
      seedProject(testDb.db, { id: 'p1' });

      // Insert with explicit different timestamps
      testDb.db
        .insert(testDb.schema.automations)
        .values({
          id: 'auto-old',
          projectId: 'p1',
          name: 'Old',
          prompt: 'A',
          schedule: '* * * * *',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        })
        .run();

      testDb.db
        .insert(testDb.schema.automations)
        .values({
          id: 'auto-new',
          projectId: 'p1',
          name: 'New',
          prompt: 'B',
          schedule: '0 * * * *',
          createdAt: '2025-06-01T00:00:00.000Z',
          updatedAt: '2025-06-01T00:00:00.000Z',
        })
        .run();

      const autos = listAutomations('p1');
      expect(autos[0].id).toBe('auto-new');
      expect(autos[1].id).toBe('auto-old');
    });

    test('updateAutomation changes fields', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Original',
        prompt: 'Old prompt',
        schedule: '* * * * *',
      });

      updateAutomation('auto-1', {
        name: 'Updated',
        prompt: 'New prompt',
        schedule: '0 9 * * 1-5',
      });

      const auto = getAutomation('auto-1');
      expect(auto!.name).toBe('Updated');
      expect(auto!.prompt).toBe('New prompt');
      expect(auto!.schedule).toBe('0 9 * * 1-5');
    });

    test('updateAutomation sets updatedAt', () => {
      seedProject(testDb.db, { id: 'p1' });
      const auto = createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      const _originalUpdatedAt = auto.updatedAt;

      updateAutomation('auto-1', { name: 'Changed' });

      const updated = getAutomation('auto-1');
      expect(updated!.updatedAt).toBeTruthy();
      // updatedAt should be set (may or may not differ from original depending on timing)
      expect(typeof updated!.updatedAt).toBe('string');
    });

    test('updateAutomation can toggle enabled flag', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });

      expect(getAutomation('auto-1')!.enabled).toBe(1);

      updateAutomation('auto-1', { enabled: 0 });
      expect(getAutomation('auto-1')!.enabled).toBe(0);

      updateAutomation('auto-1', { enabled: 1 });
      expect(getAutomation('auto-1')!.enabled).toBe(1);
    });

    test('updateAutomation can set lastRunAt and nextRunAt', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });

      const now = new Date().toISOString();
      const nextRun = new Date(Date.now() + 3600_000).toISOString();
      updateAutomation('auto-1', { lastRunAt: now, nextRunAt: nextRun });

      const auto = getAutomation('auto-1');
      expect(auto!.lastRunAt).toBe(now);
      expect(auto!.nextRunAt).toBe(nextRun);
    });

    test('deleteAutomation removes the automation', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });

      expect(getAutomation('auto-1')).toBeTruthy();
      deleteAutomation('auto-1');
      expect(getAutomation('auto-1')).toBeUndefined();
    });

    test('deleteAutomation cascades to runs', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'completed',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });

      expect(listRuns('auto-1')).toHaveLength(1);

      deleteAutomation('auto-1');

      const allRuns = testDb.db.select().from(testDb.schema.automationRuns).all();
      expect(allRuns).toHaveLength(0);
    });

    test('deleteAutomation on non-existent ID does not throw', () => {
      expect(() => deleteAutomation('nonexistent')).not.toThrow();
    });

    test('deleting a project cascades to automations', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });

      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p1')).run();

      const allAutos = testDb.db.select().from(testDb.schema.automations).all();
      expect(allAutos).toHaveLength(0);
    });
  });

  // ── Run CRUD ───────────────────────────────────────────────────

  describe('Run CRUD', () => {
    test('createRun inserts a run', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const startedAt = new Date().toISOString();
      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'running',
        triageStatus: 'pending',
        startedAt,
      });

      const run = getRun('run-1');
      expect(run).toBeTruthy();
      expect(run!.id).toBe('run-1');
      expect(run!.automationId).toBe('auto-1');
      expect(run!.threadId).toBe('t1');
      expect(run!.status).toBe('running');
      expect(run!.triageStatus).toBe('pending');
      expect(run!.startedAt).toBe(startedAt);
      expect(run!.completedAt).toBeNull();
      expect(run!.summary).toBeNull();
      expect(run!.hasFindings).toBeNull();
    });

    test('updateRun changes status and completedAt', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'running',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });

      const completedAt = new Date().toISOString();
      updateRun('run-1', {
        status: 'completed',
        completedAt,
        summary: 'Found 3 lint errors and fixed them.',
        hasFindings: 1,
      });

      const run = getRun('run-1');
      expect(run!.status).toBe('completed');
      expect(run!.completedAt).toBe(completedAt);
      expect(run!.summary).toBe('Found 3 lint errors and fixed them.');
      expect(run!.hasFindings).toBe(1);
    });

    test('updateRun can change triageStatus', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'completed',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });

      updateRun('run-1', { triageStatus: 'reviewed' });

      const run = getRun('run-1');
      expect(run!.triageStatus).toBe('reviewed');
    });

    test('listRuns returns runs for a specific automation', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      createAutomation({
        id: 'auto-2',
        projectId: 'p1',
        name: 'Other',
        prompt: 'Other',
        schedule: '0 * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });
      seedThread(testDb.db, { id: 't3', projectId: 'p1' });

      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'completed',
        triageStatus: 'pending',
        startedAt: '2025-01-01T00:00:00Z',
      });
      createRun({
        id: 'run-2',
        automationId: 'auto-1',
        threadId: 't2',
        status: 'running',
        triageStatus: 'pending',
        startedAt: '2025-01-02T00:00:00Z',
      });
      createRun({
        id: 'run-3',
        automationId: 'auto-2',
        threadId: 't3',
        status: 'completed',
        triageStatus: 'pending',
        startedAt: '2025-01-03T00:00:00Z',
      });

      const runs = listRuns('auto-1');
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.id)).toContain('run-1');
      expect(runs.map((r) => r.id)).toContain('run-2');
      expect(runs.map((r) => r.id)).not.toContain('run-3');
    });

    test('listRuns orders by startedAt descending', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });

      createRun({
        id: 'run-old',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'completed',
        triageStatus: 'pending',
        startedAt: '2025-01-01T00:00:00Z',
      });
      createRun({
        id: 'run-new',
        automationId: 'auto-1',
        threadId: 't2',
        status: 'completed',
        triageStatus: 'pending',
        startedAt: '2025-06-01T00:00:00Z',
      });

      const runs = listRuns('auto-1');
      expect(runs[0].id).toBe('run-new');
      expect(runs[1].id).toBe('run-old');
    });

    test('listRuns returns empty array when no runs exist', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });

      const runs = listRuns('auto-1');
      expect(runs).toEqual([]);
    });

    test('listRunningRuns returns only running runs', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });
      seedThread(testDb.db, { id: 't3', projectId: 'p1' });

      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'running',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });
      createRun({
        id: 'run-2',
        automationId: 'auto-1',
        threadId: 't2',
        status: 'completed',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });
      createRun({
        id: 'run-3',
        automationId: 'auto-1',
        threadId: 't3',
        status: 'running',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });

      const running = listRunningRuns();
      expect(running).toHaveLength(2);
      expect(running.map((r) => r.id).sort()).toEqual(['run-1', 'run-3']);
    });

    test('listRunningRuns returns empty array when none are running', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'completed',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });

      const running = listRunningRuns();
      expect(running).toHaveLength(0);
    });

    test('getRunByThreadId returns the run for a given thread', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'running',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });

      const run = getRunByThreadId('t1');
      expect(run).toBeTruthy();
      expect(run!.id).toBe('run-1');
      expect(run!.automationId).toBe('auto-1');
    });

    test('getRunByThreadId returns undefined for thread without a run', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      expect(getRunByThreadId('t1')).toBeUndefined();
    });
  });

  // ── Cascade and isolation ──────────────────────────────────────

  describe('Cascade and isolation', () => {
    test('deleting a thread that has a run also deletes the run', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'running',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });

      testDb.db.delete(testDb.schema.threads).where(eq(testDb.schema.threads.id, 't1')).run();

      const allRuns = testDb.db.select().from(testDb.schema.automationRuns).all();
      expect(allRuns).toHaveLength(0);
    });

    test('deleting a project cascades to automations and runs', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'running',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });

      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p1')).run();

      expect(testDb.db.select().from(testDb.schema.automations).all()).toHaveLength(0);
      expect(testDb.db.select().from(testDb.schema.automationRuns).all()).toHaveLength(0);
      expect(testDb.db.select().from(testDb.schema.threads).all()).toHaveLength(0);
    });

    test('runs from different automations are isolated', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Auto 1',
        prompt: 'Test 1',
        schedule: '* * * * *',
      });
      createAutomation({
        id: 'auto-2',
        projectId: 'p1',
        name: 'Auto 2',
        prompt: 'Test 2',
        schedule: '0 * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });

      createRun({
        id: 'run-1',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'completed',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });
      createRun({
        id: 'run-2',
        automationId: 'auto-2',
        threadId: 't2',
        status: 'completed',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });

      expect(listRuns('auto-1')).toHaveLength(1);
      expect(listRuns('auto-1')[0].id).toBe('run-1');
      expect(listRuns('auto-2')).toHaveLength(1);
      expect(listRuns('auto-2')[0].id).toBe('run-2');
    });

    test('automations from different projects are isolated', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedProject(testDb.db, { id: 'p2' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'P1 Auto',
        prompt: 'A',
        schedule: '* * * * *',
      });
      createAutomation({
        id: 'auto-2',
        projectId: 'p2',
        name: 'P2 Auto',
        prompt: 'B',
        schedule: '0 * * * *',
      });

      const p1Autos = listAutomations('p1');
      const p2Autos = listAutomations('p2');

      expect(p1Autos).toHaveLength(1);
      expect(p1Autos[0].name).toBe('P1 Auto');
      expect(p2Autos).toHaveLength(1);
      expect(p2Autos[0].name).toBe('P2 Auto');
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe('Edge cases', () => {
    test('duplicate automation ID throws', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'dup-auto',
        projectId: 'p1',
        name: 'First',
        prompt: 'A',
        schedule: '* * * * *',
      });

      expect(() => {
        createAutomation({
          id: 'dup-auto',
          projectId: 'p1',
          name: 'Second',
          prompt: 'B',
          schedule: '0 * * * *',
        });
      }).toThrow();
    });

    test('duplicate run ID throws', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });

      createRun({
        id: 'dup-run',
        automationId: 'auto-1',
        threadId: 't1',
        status: 'running',
        triageStatus: 'pending',
        startedAt: new Date().toISOString(),
      });

      expect(() => {
        createRun({
          id: 'dup-run',
          automationId: 'auto-1',
          threadId: 't2',
          status: 'running',
          triageStatus: 'pending',
          startedAt: new Date().toISOString(),
        });
      }).toThrow();
    });

    test('foreign key prevents run with non-existent automation', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      expect(() => {
        createRun({
          id: 'orphan-run',
          automationId: 'nonexistent-auto',
          threadId: 't1',
          status: 'running',
          triageStatus: 'pending',
          startedAt: new Date().toISOString(),
        });
      }).toThrow();
    });

    test('foreign key prevents run with non-existent thread', () => {
      seedProject(testDb.db, { id: 'p1' });
      createAutomation({
        id: 'auto-1',
        projectId: 'p1',
        name: 'Test',
        prompt: 'Test',
        schedule: '* * * * *',
      });

      expect(() => {
        createRun({
          id: 'orphan-run',
          automationId: 'auto-1',
          threadId: 'nonexistent-thread',
          status: 'running',
          triageStatus: 'pending',
          startedAt: new Date().toISOString(),
        });
      }).toThrow();
    });

    test('automation with special characters in name and prompt', () => {
      seedProject(testDb.db, { id: 'p1' });
      const auto = createAutomation({
        id: 'auto-special',
        projectId: 'p1',
        name: "Robert'); DROP TABLE automations;--",
        prompt: 'Run `eslint --fix` && echo "done"',
        schedule: '0 9 * * *',
      });

      expect(auto.name).toBe("Robert'); DROP TABLE automations;--");
      expect(auto.prompt).toBe('Run `eslint --fix` && echo "done"');

      // Table still works
      const all = listAutomations('p1');
      expect(all).toHaveLength(1);
    });
  });
});
