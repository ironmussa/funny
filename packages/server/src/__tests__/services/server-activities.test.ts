/**
 * Server-run activities (track-funny-actions, design D7): rows without a
 * runner, `on-failure` kinds that record only failures, instant records,
 * interruption at start, and a failing repository that never fails the action.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { Activity } from '@funny/shared';
import { err, ok } from 'neverthrow';

import { repos } from '../../db/repos.js';
import {
  createServerActivities,
  interruptServerActivities,
  type ServerActivitySpec,
} from '../../services/activities/server-activities.js';

const PROVISION: ServerActivitySpec = {
  kind: 'sandbox.provision',
  userId: 'alice',
  threadId: 't1',
  title: 'Provision sandbox',
  input: { connectionId: 'conn-1' },
  origin: 'user',
};
const WAKE: ServerActivitySpec = {
  kind: 'sandbox.wake',
  userId: 'alice',
  threadId: 't1',
  title: 'Wake sandbox',
  input: {},
  origin: 'system',
};

describe('server activities', () => {
  let db: (typeof import('../../db/index.js'))['db'];
  let broadcasts: Activity[];
  let ids: number;
  let activities: ReturnType<typeof createServerActivities>;

  beforeAll(async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    db = (await import('../../db/index.js')).db;
  });

  beforeEach(() => {
    db.run('DELETE FROM activities');
    broadcasts = [];
    ids = 0;
    activities = createServerActivities({
      broadcast: (a) => broadcasts.push(a),
      broadcastRemoved: () => {},
      newId: () => `s${++ids}`,
    });
  });

  test('ok: a row without a runner ends succeeded with its effects', async () => {
    const result = await activities.trackServerActivity(PROVISION, async (a) => {
      a.step('Creating machine');
      a.effect('sandbox-stopped', 'old');
      return ok(1);
    });
    expect(result.isOk()).toBe(true);
    const row = await repos.activities().getById('s1');
    expect(row).toMatchObject({
      runnerId: null,
      userId: 'alice',
      status: 'succeeded',
      step: 'Creating machine',
      effects: [{ effect: 'sandbox-stopped', target: 'old' }],
    });
    expect(row?.endedAt).not.toBeNull();
    expect(broadcasts.map((b) => b.status)).toEqual(['running', 'running', 'succeeded']);
  });

  test('err: the activity fails with the message and the result is returned', async () => {
    const result = await activities.trackServerActivity(PROVISION, async () => err('no quota'));
    expect(result.isErr()).toBe(true);
    expect(await repos.activities().getById('s1')).toMatchObject({
      status: 'failed',
      error: 'no quota',
    });
  });

  test('throw: the activity fails and the error is rethrown', async () => {
    await expect(
      activities.trackServerActivity(PROVISION, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await repos.activities().getById('s1'))?.status).toBe('failed');
  });

  test('on-failure kind: a success records nothing, a failure one finished row', async () => {
    await activities.trackServerActivity(WAKE, async () => ok(undefined));
    await activities.recordServerActivity(WAKE, { ok: true });
    expect(await repos.activities().listByUser('alice')).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);

    await activities.trackServerActivity(WAKE, async () => err('lost'));
    const rows = await repos.activities().listByUser('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'sandbox.wake', status: 'failed', error: 'lost' });
    expect(broadcasts.map((b) => b.status)).toEqual(['failed']);
  });

  test('record: an instant action is written finished', async () => {
    await activities.recordServerActivity(
      {
        kind: 'factory.disabled',
        userId: 'alice',
        projectId: 'p1',
        title: 'Factory disabled',
        input: { reason: 'access-lost' },
        origin: 'system',
      },
      { ok: true, effects: [{ effect: 'factory-disabled', target: 'p1' }] },
    );
    const row = await repos.activities().getById('s1');
    expect(row?.status).toBe('succeeded');
    expect(row?.endedAt).toBe(row?.startedAt ?? 'missing');
  });

  test('a failing repository does not fail the action', async () => {
    const failing = createServerActivities({
      repo: () => ({
        insert: () => Promise.reject(new Error('db down')),
        update: () => Promise.reject(new Error('db down')),
        getById: () => Promise.reject(new Error('db down')),
      }),
      broadcast: () => {},
    });
    const result = await failing.trackServerActivity(PROVISION, async () => ok('done'));
    expect(result._unsafeUnwrap()).toBe('done');
    await failing.recordServerActivity(PROVISION, { ok: false, error: 'x' });
  });

  test('server start interrupts running server rows only', async () => {
    const handle = activities.beginServerActivity(PROVISION);
    await handle.settled();
    await repos.activities().insert({
      id: 'runner-row',
      userId: 'alice',
      runnerId: 'laptop',
      kind: 'project.clone',
      projectId: null,
      threadId: null,
      title: 'Clone',
      input: { cloneUrl: 'https://x/y.git', destinationPath: '/tmp/y' },
      startedAt: new Date().toISOString(),
    });
    expect(await interruptServerActivities()).toBe(1);
    expect((await repos.activities().getById('s1'))?.status).toBe('interrupted');
    expect((await repos.activities().getById('runner-row'))?.status).toBe('running');
  });
});
