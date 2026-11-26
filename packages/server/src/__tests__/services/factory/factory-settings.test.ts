import { beforeEach, describe, expect, test } from 'bun:test';

import { createFactoryRunsRepository } from '../../../services/factory/factory-runs.js';
import { createFactorySettingsService } from '../../../services/factory/factory-settings.js';
import { present } from '../../helpers/builders-services.js';
import { createTestDb, seedProject, seedProjectMember } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
let ids = 0;
const settings = () => createFactorySettingsService({ newId: () => `f${++ids}` });

beforeEach(async () => {
  testDb = createTestDb();
  ids = 0;
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  seedProject(testDb.db, { id: 'bob-project', userId: 'bob', path: '/tmp/bob' });
});

describe('factory settings service', () => {
  test('defaults when none configured, then saves and reads back', async () => {
    const svc = settings();
    expect((await svc.get('alice', 'p1'))._unsafeUnwrap()).toBeNull();

    const saved = (
      await svc.save('alice', 'p1', { enabled: true, label: 'ready-for-agent', maxConcurrent: 3 })
    )._unsafeUnwrap();
    expect(saved).toMatchObject({
      projectId: 'p1',
      enabled: true,
      label: 'ready-for-agent',
      flowName: 'issue-to-merge',
      maxConcurrent: 3,
    });
    expect((await svc.get('alice', 'p1'))._unsafeUnwrap()).toEqual(saved);
  });

  test('saving again updates the single row in place', async () => {
    const svc = settings();
    (await svc.save('alice', 'p1', { enabled: true }))._unsafeUnwrap();
    (await svc.save('alice', 'p1', { enabled: false, maxConcurrent: 5 }))._unsafeUnwrap();
    const read = (await svc.get('alice', 'p1'))._unsafeUnwrap();
    expect(read).toMatchObject({ enabled: false, maxConcurrent: 5 });
    const rows = present(
      testDb.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM factory_settings').get(),
      'a count',
    );
    expect(rows.n).toBe(1);
  });

  test('a project member (not owner) can run their own factory; an outsider cannot', async () => {
    const svc = settings();
    seedProjectMember(testDb.db, { projectId: 'bob-project', userId: 'alice', role: 'member' });
    expect(
      (await svc.save('alice', 'bob-project', { enabled: true }))._unsafeUnwrap().enabled,
    ).toBe(true);
    const outsider = await svc.save('carol', 'bob-project', { enabled: true });
    expect(outsider.isErr() && outsider.error.kind).toBe('not-found');
  });

  test('a viewer member can read but not enable a factory', async () => {
    const svc = settings();
    // `setMemberLocalPath` writes viewer rows like this one for org viewers.
    seedProjectMember(testDb.db, { projectId: 'bob-project', userId: 'alice', role: 'viewer' });
    expect((await svc.get('alice', 'bob-project'))._unsafeUnwrap()).toBeNull();
    const saved = await svc.save('alice', 'bob-project', { enabled: true });
    expect(saved.isErr() && saved.error.kind).toBe('forbidden');
    const rows = present(
      testDb.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM factory_settings').get(),
      'a count',
    );
    expect(rows.n).toBe(0);
  });

  test('each user keeps their own factory for the same project', async () => {
    const svc = settings();
    seedProjectMember(testDb.db, { projectId: 'p1', userId: 'bob', role: 'member' });
    (await svc.save('alice', 'p1', { enabled: true, label: 'alice-label' }))._unsafeUnwrap();
    (await svc.save('bob', 'p1', { enabled: false, label: 'bob-label' }))._unsafeUnwrap();
    expect((await svc.get('alice', 'p1'))._unsafeUnwrap()?.label).toBe('alice-label');
    expect((await svc.get('bob', 'p1'))._unsafeUnwrap()?.label).toBe('bob-label');
  });

  test('rejects an empty label and an out-of-range concurrency', async () => {
    const svc = settings();
    expect((await svc.save('alice', 'p1', { enabled: true, label: '  ' })).isErr()).toBe(true);
    expect((await svc.save('alice', 'p1', { enabled: true, maxConcurrent: 0 })).isErr()).toBe(true);
    expect((await svc.save('alice', 'p1', { enabled: true, maxConcurrent: 99 })).isErr()).toBe(
      true,
    );
  });
});

describe('factory runs repository', () => {
  const runs = () => createFactoryRunsRepository({ newId: () => `r${++ids}` });

  const makeFactory = async (): Promise<string> => {
    (await settings().save('alice', 'p1', { enabled: true }))._unsafeUnwrap();
    return present(
      testDb.sqlite.query<{ id: string }, []>('SELECT id FROM factory_settings LIMIT 1').get(),
      'a factory',
    ).id;
  };

  test('one active run per issue; terminal frees the issue', async () => {
    const repo = runs();
    const factoryId = await makeFactory();
    const run = (
      await repo.start({ factoryId, issueNumber: 42, currentStep: 'implement' })
    )._unsafeUnwrap();
    expect((await repo.activeByIssue(factoryId, 42))._unsafeUnwrap()?.id).toBe(run.id);
    expect((await repo.countActive(factoryId))._unsafeUnwrap()).toBe(1);

    (await repo.updateInFlight(run.id, { state: 'merged' }))._unsafeUnwrap();
    expect((await repo.activeByIssue(factoryId, 42))._unsafeUnwrap()).toBeNull();
    expect((await repo.countActive(factoryId))._unsafeUnwrap()).toBe(0);
  });

  test('update records state, step, pr and thread ids; completedAt on terminal', async () => {
    const repo = runs();
    const factoryId = await makeFactory();
    const run = (await repo.start({ factoryId, issueNumber: 7 }))._unsafeUnwrap();
    (
      await repo.updateInFlight(run.id, {
        state: 'pr_open',
        currentStep: 'review',
        prUrl: 'https://x/pr/1',
        threadIds: ['t1', 't2'],
      })
    )._unsafeUnwrap();
    const [listed] = (await repo.list(factoryId))._unsafeUnwrap();
    expect(listed).toMatchObject({
      state: 'pr_open',
      currentStep: 'review',
      prUrl: 'https://x/pr/1',
      threadIds: ['t1', 't2'],
      completedAt: null,
    });
    (await repo.updateInFlight(run.id, { state: 'failed' }))._unsafeUnwrap();
    expect((await repo.list(factoryId))._unsafeUnwrap()[0]?.completedAt).not.toBeNull();
  });

  test('stopMany terminal-marks the given runs', async () => {
    const repo = runs();
    const factoryId = await makeFactory();
    const a = (await repo.start({ factoryId, issueNumber: 1 }))._unsafeUnwrap();
    const b = (await repo.start({ factoryId, issueNumber: 2 }))._unsafeUnwrap();
    (await repo.stopMany([a.id, b.id]))._unsafeUnwrap();
    expect((await repo.countActive(factoryId))._unsafeUnwrap()).toBe(0);
  });

  test('two saves in flight do not undo each other (the label save leaves the mode alone)', async () => {
    const settings = createFactorySettingsService();
    await settings.save('alice', 'p1', { enabled: true, mode: 'automatic', label: 'old' });

    await Promise.all([
      settings.save('alice', 'p1', { enabled: true, label: 'new' }),
      settings.save('alice', 'p1', { enabled: true, mode: 'manual' }),
    ]);

    const stored = (await settings.get('alice', 'p1'))._unsafeUnwrap();
    expect(stored).toMatchObject({ mode: 'manual', label: 'new' });
  });
});

// openspec factory-lanes, D1: what a member may do with the lanes of their factory.
describe('factory lanes in the settings', () => {
  async function factoryWithLane() {
    const svc = settings();
    (await svc.save('alice', 'p1', { enabled: true, baseBranch: 'dev' }))._unsafeUnwrap();
    const factoryId = present((await svc.factoryId('alice', 'p1'))._unsafeUnwrap(), 'a factory');
    const { createFactoryLanesRepository } =
      await import('../../../services/factory/factory-lanes.js');
    (
      await createFactoryLanesRepository().ensure(factoryId, {
        name: 'payments',
        branch: 'feature/payments',
      })
    )._unsafeUnwrap();
    return { svc, factoryId };
  }

  // D11: `feature:` is a common team label; the factory's own convention does not collide with it.
  test('the prefixes default to lane: and lane/, and a save changes them', async () => {
    const svc = settings();
    const saved = (await svc.save('alice', 'p1', { enabled: true }))._unsafeUnwrap();
    expect(saved).toMatchObject({ laneLabelPrefix: 'lane:', laneBranchPrefix: 'lane/' });
    const changed = (
      await svc.save('alice', 'p1', {
        enabled: true,
        laneLabelPrefix: 'epic:',
        laneBranchPrefix: 'epics/',
      })
    )._unsafeUnwrap();
    expect(changed).toMatchObject({ laneLabelPrefix: 'epic:', laneBranchPrefix: 'epics/' });
  });

  test('a prefix that is not usable is refused', async () => {
    const svc = settings();
    const spaced = await svc.save('alice', 'p1', { enabled: true, laneLabelPrefix: 'my feature:' });
    expect(spaced._unsafeUnwrapErr().kind).toBe('invalid');
    const branch = await svc.save('alice', 'p1', { enabled: true, laneBranchPrefix: '/feature/' });
    expect(branch._unsafeUnwrapErr().kind).toBe('invalid');
  });

  test('"merge into" and the prefixes cannot change while the factory has lanes', async () => {
    const { svc } = await factoryWithLane();
    for (const change of [
      { baseBranch: 'main' },
      { laneLabelPrefix: 'epic:' },
      { laneBranchPrefix: 'epics/' },
    ]) {
      const refused = (
        await svc.save('alice', 'p1', { enabled: true, ...change })
      )._unsafeUnwrapErr();
      expect(refused.kind).toBe('invalid');
      expect(refused.message).toContain('payments');
    }
    // Saving the same values, or anything else, still works.
    const same = await svc.save('alice', 'p1', {
      enabled: true,
      baseBranch: 'dev',
      maxConcurrent: 4,
    });
    expect(same._unsafeUnwrap()).toMatchObject({ baseBranch: 'dev', maxConcurrent: 4 });
  });

  test('a member lists the lanes of their own factory only', async () => {
    const { svc } = await factoryWithLane();
    expect((await svc.lanes('alice', 'p1'))._unsafeUnwrap()).toMatchObject([
      { name: 'payments', branch: 'feature/payments', state: 'active' },
    ]);
    seedProjectMember(testDb.db, { projectId: 'p1', userId: 'bob', role: 'member' });
    expect((await svc.lanes('bob', 'p1'))._unsafeUnwrap()).toEqual([]);
    expect((await svc.lanes('mallory', 'p1'))._unsafeUnwrapErr().kind).toBe('not-found');
  });

  test('a lane with a run that has not ended cannot be removed; afterwards it can', async () => {
    const { svc, factoryId } = await factoryWithLane();
    const runs = createFactoryRunsRepository();
    const run = (
      await runs.start({
        factoryId,
        issueNumber: 30,
        state: 'working',
        baseBranch: 'feature/payments',
        lane: 'payments',
      })
    )._unsafeUnwrap();

    const refused = (await svc.removeLane('alice', 'p1', 'payments'))._unsafeUnwrapErr();
    expect(refused.kind).toBe('invalid');
    expect(refused.message).toContain('#30');

    testDb.sqlite.run(`UPDATE factory_runs SET state = 'merged' WHERE id = '${run.id}'`);
    (await svc.removeLane('alice', 'p1', 'Payments'))._unsafeUnwrap();
    expect((await svc.lanes('alice', 'p1'))._unsafeUnwrap()).toEqual([]);
  });

  test('a lane being synced cannot be removed, and an unknown lane is not found', async () => {
    const { svc } = await factoryWithLane();
    testDb.sqlite.run(`UPDATE factory_lanes SET sync_state = 'checking'`);
    expect((await svc.removeLane('alice', 'p1', 'payments'))._unsafeUnwrapErr().kind).toBe(
      'invalid',
    );
    expect((await svc.removeLane('alice', 'p1', 'nope'))._unsafeUnwrapErr().kind).toBe('not-found');
  });

  test('removing a lane needs steer on the project', async () => {
    await factoryWithLane();
    seedProjectMember(testDb.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    const refused = (await settings().removeLane('vic', 'p1', 'payments'))._unsafeUnwrapErr();
    expect(refused.kind).toBe('forbidden');
  });

  // D4: what a member's "sync now" does to the lane's sync.
  test('sync now: an idle lane forgets its last sync, one waiting for a person tries again', async () => {
    const { svc } = await factoryWithLane();
    void svc;
    const { requestLaneSync } = await import('../../../services/factory/factory-settings.js');
    testDb.sqlite.run(`UPDATE factory_lanes SET sync_started_at = '2026-11-26T10:00:00Z'`);
    const row = () =>
      present(
        testDb.sqlite
          .query<
            { sync_state: string; sync_started_at: string | null; sync_error: string | null },
            []
          >('SELECT sync_state, sync_started_at, sync_error FROM factory_lanes')
          .get(),
        'the lane',
      );

    expect((await requestLaneSync('alice', 'p1', 'payments'))._unsafeUnwrap()).toBe('requested');
    expect(row()).toMatchObject({ sync_state: 'idle', sync_started_at: null });

    testDb.sqlite.run(
      `UPDATE factory_lanes SET sync_state = 'needs_human', sync_error = 'conflict'`,
    );
    expect((await requestLaneSync('alice', 'p1', 'payments'))._unsafeUnwrap()).toBe('retried');
    expect(row()).toMatchObject({ sync_state: 'merging', sync_error: null });

    // In flight: left alone.
    expect((await requestLaneSync('alice', 'p1', 'payments'))._unsafeUnwrap()).toBe('in-flight');
    expect((await requestLaneSync('alice', 'p1', 'nope'))._unsafeUnwrapErr().kind).toBe(
      'not-found',
    );
    seedProjectMember(testDb.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    expect((await requestLaneSync('vic', 'p1', 'payments'))._unsafeUnwrapErr().kind).toBe(
      'forbidden',
    );
  });
});
