/**
 * Unit tests for thread-registry — register, resolve runner, status updates, list, unregister.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import { seedDbFor } from '../helpers/builders-services.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedRunner, seedThread } from '../helpers/test-db.js';

describe('thread-registry service', () => {
  let t: TestApp;
  let tr: typeof import('../../services/thread-registry.js');

  beforeAll(async () => {
    t = await createTestApp();
    tr = await import('../../services/thread-registry.js');
  });

  beforeEach(() => {
    t.cleanup();
  });

  describe('registerThread', () => {
    test('inserts a new project thread with defaults', async () => {
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/repo' });
      seedRunner(seedDbFor(t.db), { id: 'runner-1', userId: 'user-1' });

      await tr.registerThread({
        id: 't-new',
        projectId: 'p1',
        runnerId: 'runner-1',
        userId: 'user-1',
        title: 'My thread',
        model: 'sonnet',
        mode: 'local',
        branch: 'feature/x',
      });

      const row = await t.db
        .select()
        .from(t.schema.threads)
        .where(eq(t.schema.threads.id, 't-new'))
        .get();

      expect(row?.title).toBe('My thread');
      expect(row?.runnerId).toBe('runner-1');
      expect(row?.status).toBe('idle');
      expect(row?.stage).toBe('backlog');
      expect(row?.model).toBe('sonnet');
      expect(row?.branch).toBe('feature/x');
      expect(row?.isScratch).toBe(0);
    });

    test('upserts on conflict and updates runner metadata', async () => {
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/repo' });
      seedRunner(seedDbFor(t.db), { id: 'runner-1', userId: 'user-1', token: 'tok-runner-1' });
      seedRunner(seedDbFor(t.db), { id: 'runner-2', userId: 'user-1', token: 'tok-runner-2' });
      seedThread(seedDbFor(t.db), {
        id: 't-upsert',
        projectId: 'p1',
        userId: 'user-1',
        runnerId: 'runner-1',
        title: 'Old title',
        branch: 'main',
      });

      await tr.registerThread({
        id: 't-upsert',
        projectId: 'p1',
        runnerId: 'runner-2',
        userId: 'user-1',
        title: 'New title',
        model: 'opus',
      });

      const row = await t.db
        .select()
        .from(t.schema.threads)
        .where(eq(t.schema.threads.id, 't-upsert'))
        .get();

      expect(row?.runnerId).toBe('runner-2');
      expect(row?.title).toBe('New title');
      expect(row?.model).toBe('opus');
      // branch omitted on upsert — existing branch preserved
      expect(row?.branch).toBe('main');
    });

    test('registers scratch threads with null projectId', async () => {
      seedRunner(seedDbFor(t.db), { id: 'runner-1', userId: 'user-1' });

      await tr.registerThread({
        id: 't-scratch',
        projectId: null,
        runnerId: 'runner-1',
        userId: 'user-1',
        title: 'Scratch pad',
        isScratch: true,
      });

      const row = await t.db
        .select()
        .from(t.schema.threads)
        .where(eq(t.schema.threads.id, 't-scratch'))
        .get();

      expect(row?.projectId).toBeNull();
      expect(row?.isScratch).toBe(1);
      expect(row?.mode).toBe('local');
    });
  });

  describe('getRunnerForThread', () => {
    test('returns the runner identity when thread belongs to the user', async () => {
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/repo' });
      seedRunner(seedDbFor(t.db), {
        id: 'runner-1',
        userId: 'user-1',
        httpUrl: 'http://127.0.0.1:3003',
      });
      seedThread(seedDbFor(t.db), {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        runnerId: 'runner-1',
      });

      const info = await tr.getRunnerForThread('t1', 'user-1');
      expect(info).toEqual({ runnerId: 'runner-1' });
    });

    test('returns null for cross-tenant lookup', async () => {
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-2', path: '/repo' });
      seedRunner(seedDbFor(t.db), { id: 'runner-2', userId: 'user-2' });
      seedThread(seedDbFor(t.db), {
        id: 't1',
        projectId: 'p1',
        userId: 'user-2',
        runnerId: 'runner-2',
      });

      expect(await tr.getRunnerForThread('t1', 'user-1')).toBeNull();
    });

    test('returns null when thread has no runner', async () => {
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/repo' });
      seedThread(seedDbFor(t.db), {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        runnerId: null,
      });

      expect(await tr.getRunnerForThread('t1', 'user-1')).toBeNull();
    });
  });

  describe('updateThreadStatus', () => {
    test('updates status and optional stage', async () => {
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/repo' });
      seedThread(seedDbFor(t.db), {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        status: 'idle',
        stage: 'backlog',
      });

      await tr.updateThreadStatus('t1', 'running', 'in_progress');

      const row = await t.db
        .select()
        .from(t.schema.threads)
        .where(eq(t.schema.threads.id, 't1'))
        .get();

      expect(row?.status).toBe('running');
      expect(row?.stage).toBe('in_progress');
      expect(row?.completedAt).toBeNull();
    });

    test('sets completedAt when status is terminal', async () => {
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/repo' });
      seedThread(seedDbFor(t.db), {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        status: 'running',
      });

      await tr.updateThreadStatus('t1', 'completed');

      const row = await t.db
        .select()
        .from(t.schema.threads)
        .where(eq(t.schema.threads.id, 't1'))
        .get();

      expect(row?.status).toBe('completed');
      expect(row?.completedAt).toBeTruthy();
    });
  });

  describe('listThreadsForProject', () => {
    test('returns lightweight metadata for threads in a project', async () => {
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/repo' });
      seedProject(seedDbFor(t.db), { id: 'p2', userId: 'user-1', path: '/other' });
      seedThread(seedDbFor(t.db), { id: 't1', projectId: 'p1', userId: 'user-1', title: 'One' });
      seedThread(seedDbFor(t.db), { id: 't2', projectId: 'p1', userId: 'user-1', title: 'Two' });
      seedThread(seedDbFor(t.db), { id: 't3', projectId: 'p2', userId: 'user-1', title: 'Other' });

      const rows = await tr.listThreadsForProject('p1');
      expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't2']);
      expect(rows[0]).toMatchObject({
        projectId: 'p1',
        userId: 'user-1',
        title: expect.any(String),
        status: expect.any(String),
        stage: expect.any(String),
      });
    });
  });

  describe('unregisterThread', () => {
    test('removes the thread row', async () => {
      seedProject(seedDbFor(t.db), { id: 'p1', userId: 'user-1', path: '/repo' });
      seedThread(seedDbFor(t.db), { id: 't1', projectId: 'p1', userId: 'user-1' });

      await tr.unregisterThread('t1');

      const row = await t.db
        .select()
        .from(t.schema.threads)
        .where(eq(t.schema.threads.id, 't1'))
        .get();

      expect(row).toBeUndefined();
    });
  });
});
