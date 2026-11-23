/**
 * Background activities on the runner → server data channel
 * (track-background-activities): the row's user and runner come from the
 * session, scope and ownership are enforced, a deleted runner's running rows
 * become `interrupted`, and every accepted write is broadcast to the owner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { repos } from '../../db/repos.js';
import { setIO } from '../../services/browser-events.js';
import { handleDataMessageWithAck } from '../../services/data-handler.js';
import { __resetDataOwnershipCache } from '../../services/data-ownership.js';
import { __resetDataScopeCache } from '../../services/data-scope.js';
import { removeRunner } from '../../services/runner-manager.js';
import { __resetRunnerScopeCache, setProjectDedicatedRunner } from '../../services/runner-scope.js';
import { createMockIo } from '../helpers/socketio-test-mocks.js';
import { seedProject, seedRunner, seedThread } from '../helpers/test-db.js';

const FORBIDDEN = { type: 'data:ack', success: false, error: 'Forbidden' };
const CLONE_INPUT = { cloneUrl: 'https://github.com/o/r.git', destinationPath: '/tmp/r' };

describe('activity data channel', () => {
  let db: (typeof import('../../db/index.js'))['db'];
  let capture: ReturnType<typeof createMockIo>['capture'];

  beforeAll(async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    db = (await import('../../db/index.js')).db;
  });

  beforeEach(async () => {
    for (const table of [
      'activities',
      'project_runner_grants',
      'project_runner_settings',
      'threads',
      'runner_project_assignments',
      'runners',
      'projects',
    ]) {
      db.run(`DELETE FROM ${table}`);
    }
    __resetRunnerScopeCache();
    __resetDataScopeCache();
    __resetDataOwnershipCache();
    seedProject(db, { id: 'pa', userId: 'alice', path: '/a' });
    seedProject(db, { id: 'pd', userId: 'alice', path: '/d' });
    seedProject(db, { id: 'pb', userId: 'bob', path: '/b' });
    seedThread(db, { id: 'ta', projectId: 'pa', userId: 'alice' });
    seedRunner(db, { id: 'laptop', userId: 'alice', token: 'tok-l', hostname: 'l' });
    seedRunner(db, { id: 'laptop-2', userId: 'alice', token: 'tok-l2', hostname: 'l2' });
    seedRunner(db, { id: 'rd', userId: 'alice', token: 'tok-d', hostname: 'd', role: 'dedicated' });
    seedRunner(db, { id: 'bob-runner', userId: 'bob', token: 'tok-b', hostname: 'b' });
    await setProjectDedicatedRunner('pd', 'alice', 'rd');
    const mockIo = createMockIo();
    capture = mockIo.capture;
    setIO(mockIo.io);
  });

  afterAll(() => {
    setIO(null!);
  });

  const start = (runnerId: string, owner: string, payload: Record<string, unknown>) =>
    handleDataMessageWithAck(runnerId, owner, { type: 'data:activity_start', payload });
  const update = (runnerId: string, owner: string, id: string, patch: Record<string, unknown>) =>
    handleDataMessageWithAck(runnerId, owner, {
      type: 'data:activity_update',
      payload: { id, patch },
    });
  const activityEvents = () =>
    capture.userRoomEmits.filter((e) => String(e.event).startsWith('activity:'));

  test('records the activity for the runner owner, not the user named in the payload', async () => {
    const res = await start('laptop', 'alice', {
      id: 'c1',
      kind: 'project.clone',
      title: 'Clone o/r',
      userId: 'bob',
      runnerId: 'bob-runner',
      input: { ...CLONE_INPUT, token: 'ghp_secret' },
    });
    expect(res).toMatchObject({ type: 'data:activity_start_response', applied: true });
    const row = await repos.activities().getById('c1');
    expect(row?.userId).toBe('alice');
    expect(row?.runnerId).toBe('laptop');
    expect(row?.input).toEqual(CLONE_INPUT);
  });

  test('refuses an unknown kind', async () => {
    const res = await start('laptop', 'alice', { id: 'x', kind: 'nope', title: 't', input: {} });
    expect(res.success).toBe(false);
    expect(await repos.activities().getById('x')).toBeUndefined();
  });

  test('refuses a start for a project the runner cannot serve', async () => {
    const pinned = { id: 'g1', kind: 'git.workflow', title: 'Push', input: { action: 'push' } };
    expect(await start('laptop', 'alice', { ...pinned, projectId: 'pd' })).toEqual(FORBIDDEN);
    expect(await start('laptop', 'alice', { ...pinned, projectId: 'pb' })).toEqual(FORBIDDEN);
    expect(await repos.activities().getById('g1')).toBeUndefined();
    expect((await start('rd', 'alice', { ...pinned, id: 'g2', projectId: 'pd' })).applied).toBe(
      true,
    );
  });

  test('refuses a projectless start from a dedicated runner', async () => {
    const res = await start('rd', 'alice', {
      id: 'c2',
      kind: 'project.clone',
      title: 'Clone',
      input: CLONE_INPUT,
    });
    expect(res).toEqual(FORBIDDEN);
  });

  test('refuses an update of a row owned by another user', async () => {
    await start('laptop', 'alice', {
      id: 'c3',
      kind: 'project.clone',
      title: 'C',
      input: CLONE_INPUT,
    });
    expect(await update('bob-runner', 'bob', 'c3', { status: 'failed' })).toEqual(FORBIDDEN);
    expect((await repos.activities().getById('c3'))?.status).toBe('running');
  });

  test('an update from another runner of the same user is not applied', async () => {
    await start('laptop', 'alice', {
      id: 'c4',
      kind: 'project.clone',
      title: 'C',
      input: CLONE_INPUT,
    });
    const res = await update('laptop-2', 'alice', 'c4', { status: 'succeeded' });
    expect(res.applied).toBe(false);
    expect((await repos.activities().getById('c4'))?.status).toBe('running');
  });

  test('a terminal update records the error and the end time', async () => {
    await start('laptop', 'alice', {
      id: 'c5',
      kind: 'project.clone',
      title: 'C',
      input: CLONE_INPUT,
    });
    const res = await update('laptop', 'alice', 'c5', {
      status: 'failed',
      error: 'destination exists',
    });
    expect(res.applied).toBe(true);
    const row = await repos.activities().getById('c5');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('destination exists');
    expect(row?.endedAt).not.toBeNull();
    // A runner cannot write `interrupted` itself, nor leave a final status.
    expect((await update('laptop', 'alice', 'c5', { status: 'succeeded' })).applied).toBe(false);
  });

  test('reconcile interrupts the runner rows it does not list', async () => {
    await start('laptop', 'alice', {
      id: 'live',
      kind: 'project.clone',
      title: 'L',
      input: CLONE_INPUT,
    });
    await start('laptop', 'alice', {
      id: 'gone',
      kind: 'project.clone',
      title: 'G',
      input: CLONE_INPUT,
    });
    const res = await handleDataMessageWithAck('laptop', 'alice', {
      type: 'data:activity_reconcile',
      payload: { liveIds: ['live'] },
    });
    expect(res).toMatchObject({ type: 'data:activity_reconcile_response', interrupted: 1 });
    expect((await repos.activities().getById('live'))?.status).toBe('running');
    expect((await repos.activities().getById('gone'))?.status).toBe('interrupted');
  });

  test('deleting a runner interrupts its running activities', async () => {
    await start('laptop', 'alice', {
      id: 'c6',
      kind: 'project.clone',
      title: 'C',
      input: CLONE_INPUT,
    });
    await removeRunner('laptop');
    expect((await repos.activities().getById('c6'))?.status).toBe('interrupted');
  });

  test('broadcasts one event per accepted write and none for a refused one', async () => {
    await start('laptop', 'alice', {
      id: 'c7',
      kind: 'project.clone',
      title: 'C',
      input: CLONE_INPUT,
    });
    await update('laptop', 'alice', 'c7', { step: 'Receiving objects' });
    await update('laptop', 'alice', 'c7', { status: 'succeeded', resultRef: { projectId: 'pa' } });
    await update('laptop', 'alice', 'c7', { status: 'failed' });
    await update('laptop-2', 'alice', 'c7', { step: 'x' });
    await start('rd', 'alice', { id: 'c8', kind: 'project.clone', title: 'C', input: CLONE_INPUT });

    const events = activityEvents();
    expect(events.map((e) => e.event)).toEqual([
      'activity:updated',
      'activity:updated',
      'activity:updated',
    ]);
    expect(events.every((e) => e.room === 'user:alice')).toBe(true);
    expect((events[2].payload as any).data.activity).toMatchObject({
      id: 'c7',
      status: 'succeeded',
      resultRef: { projectId: 'pa' },
    });
  });

  // ── track-funny-actions ──────────────────────────────────────────────────

  const CLEANUP_INPUT = { reason: 'manual', branch: 'b', deleteBranch: true };

  test('an instant activity is inserted finished and broadcast once', async () => {
    const res = await start('laptop', 'alice', {
      id: 'i1',
      kind: 'workspace.cleanup',
      title: 'Removed worktree',
      projectId: 'pa',
      input: CLEANUP_INPUT,
      origin: 'implicit',
      status: 'failed',
      error: 'branch is checked out',
      effects: [
        { effect: 'worktree-removed', target: '/w' },
        { effect: 'nope', target: 'x' },
      ],
    });
    expect(res.applied).toBe(true);
    const row = await repos.activities().getById('i1');
    expect(row).toMatchObject({
      status: 'failed',
      origin: 'implicit',
      error: 'branch is checked out',
      effects: [{ effect: 'worktree-removed', target: '/w' }],
    });
    expect(row?.endedAt).toBe(row?.startedAt ?? 'missing');
    expect(activityEvents()).toHaveLength(1);
    expect((await update('laptop', 'alice', 'i1', { status: 'succeeded' })).applied).toBe(false);
  });

  test('an update cannot change the origin; effects are replaced', async () => {
    await start('laptop', 'alice', {
      id: 'o1',
      kind: 'workspace.cleanup',
      title: 'Cleanup',
      projectId: 'pa',
      input: CLEANUP_INPUT,
      origin: 'implicit',
      effects: [{ effect: 'command-stopped', target: 'dev' }],
    });
    await update('laptop', 'alice', 'o1', {
      origin: 'user',
      effects: [{ effect: 'worktree-removed', target: '/w' }],
    });
    const row = await repos.activities().getById('o1');
    expect(row?.origin).toBe('implicit');
    expect(row?.effects).toEqual([{ effect: 'worktree-removed', target: '/w' }]);
  });

  test('a runner of the owner cannot update a server-run activity', async () => {
    await repos.activities().insert({
      id: 's1',
      userId: 'alice',
      runnerId: null,
      kind: 'sandbox.provision',
      projectId: null,
      threadId: 'ta',
      title: 'Provision',
      input: { connectionId: 'conn-1' },
      origin: 'user',
      startedAt: new Date().toISOString(),
    });
    expect((await update('laptop', 'alice', 's1', { status: 'failed' })).applied).toBe(false);
    expect((await repos.activities().getById('s1'))?.status).toBe('running');
  });

  test('keeps an undo snapshot ref and drops any other value', async () => {
    const base = { kind: 'project.clone', title: 'C', input: CLONE_INPUT, status: 'succeeded' };
    await start('laptop', 'alice', {
      ...base,
      id: 'u1',
      resultRef: { snapshot: 'refs/funny/undo/u1' },
    });
    await start('laptop', 'alice', {
      ...base,
      id: 'u2',
      resultRef: { snapshot: 'refs/heads/main' },
    });
    expect((await repos.activities().getById('u1'))?.resultRef).toEqual({
      snapshot: 'refs/funny/undo/u1',
    });
    expect((await repos.activities().getById('u2'))?.resultRef).toBeNull();
  });
});
