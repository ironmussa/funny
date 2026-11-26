import { beforeEach, describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import { repos } from '../../db/repos.js';
import type { FactoryGithubPort } from '../../services/factory/factory-github.js';
import { createFactoryLanesRepository } from '../../services/factory/factory-lanes.js';
import { createFactoryRunsRepository } from '../../services/factory/factory-runs.js';
import { createFactorySettingsService } from '../../services/factory/factory-settings.js';
import { lanePortMethods } from '../../trpc/ports/factory-port-lanes.js';
import type { FactoryPortDeps } from '../../trpc/ports/factory-port-shared.js';
import { createTestDb, seedProject, seedProjectMember } from '../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
let ids = 0;

function makeFakeGithub(opts: { existingPr?: number } = {}) {
  const opened: Array<{ head: string; base: string; title: string; body: string }> = [];
  let nextPr = opts.existingPr ?? 50;
  let openForHead: number | null = opts.existingPr ?? null;

  const github: Pick<
    FactoryGithubPort,
    'resolveRepo' | 'defaultBranch' | 'laneBranches' | 'pullRequests'
  > = {
    resolveRepo: async () => 'acme/app',
    defaultBranch: () => okAsync('develop'),
    laneBranches: () => ({
      branchHead: () => okAsync('sha-1'),
      branchContains: () => okAsync(true),
      resetBranch: () => okAsync(undefined),
      mergeInto: () => okAsync('merged' as const),
      deleteBranch: () => okAsync(undefined),
      openPullRequest: (input) => {
        opened.push(input);
        if (openForHead !== null) return okAsync(openForHead);
        const number = nextPr++;
        openForHead = number;
        return okAsync(number);
      },
    }),
    // SAFETY: finishing a lane reads only the pull request's state.
    pullRequests: { prState: () => okAsync('open') } as never,
  };

  return { github: github as FactoryGithubPort, opened };
}

function makePort(github: FactoryGithubPort, woken: string[]) {
  const settings = createFactorySettingsService({ newId: () => `f${++ids}` });
  const lanes = createFactoryLanesRepository({ newId: () => `l${++ids}` });
  const deps = { settings } as FactoryPortDeps;
  return {
    settings,
    lanes,
    runs: createFactoryRunsRepository({ newId: () => `r${++ids}` }),
    port: lanePortMethods(deps, {
      github: () => github,
      lanes,
      wake: (factoryId) => woken.push(factoryId),
    }),
  };
}

beforeEach(async () => {
  testDb = createTestDb();
  ids = 0;
  const { setConnection } = await import('../../db/index.js');
  setConnection({
    db: testDb.db,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  seedProjectMember(testDb.db, { projectId: 'p1', userId: 'bob', role: 'member' });
});

describe('factory port lanes (3.3, 6.6, 8.1)', () => {
  test('lanes lists the caller lanes with label, open runs and PR links, and hides another user factory', async () => {
    const woken: string[] = [];
    const { github } = makeFakeGithub();
    const { settings, lanes, runs, port } = makePort(github, woken);

    (await settings.save('alice', 'p1', { enabled: true }))._unsafeUnwrap();
    const factoryId = (await settings.factoryId('alice', 'p1'))._unsafeUnwrap()!;
    const lane = (
      await lanes.ensure(factoryId, { name: 'auth', branch: 'feature/auth' })
    )._unsafeUnwrap();
    (
      await runs.start({
        factoryId,
        issueNumber: 12,
        state: 'working',
        baseBranch: 'feature/auth',
        lane: 'auth',
      })
    )._unsafeUnwrap();

    const aliceLanes = (await port.lanes('alice', 'p1'))._unsafeUnwrap();
    expect(aliceLanes).toHaveLength(1);
    expect(aliceLanes[0]).toMatchObject({
      id: lane.id,
      name: 'auth',
      label: 'lane:auth',
      branch: 'feature/auth',
      state: 'active',
      openRuns: ['#12'],
      syncState: 'idle',
      finishPrNumber: null,
      finishPrUrl: null,
    });

    // Bob has no factory on p1 yet, so he does not see Alice's lanes.
    expect((await port.lanes('bob', 'p1'))._unsafeUnwrap()).toEqual([]);
    // Bob cannot remove, sync or finish Alice's lane (404).
    expect((await port.removeLane('bob', 'p1', 'auth'))._unsafeUnwrapErr().status).toBe(404);
    expect((await port.syncLane('bob', 'p1', 'auth'))._unsafeUnwrapErr().status).toBe(404);
    expect((await port.finishLane('bob', 'p1', 'auth'))._unsafeUnwrapErr().status).toBe(404);
  });

  test('queueLanes lists every lane of the caller factories, with or without runs, and no one else lanes (13.1)', async () => {
    const { github } = makeFakeGithub();
    const { settings, lanes, port } = makePort(github, []);
    seedProject(testDb.db, { id: 'p2', userId: 'alice' });

    // p1 keeps the prefixes of a factory saved before D11; p2 has the defaults.
    (
      await settings.save('alice', 'p1', {
        enabled: true,
        laneLabelPrefix: 'feature:',
        laneBranchPrefix: 'feature/',
      })
    )._unsafeUnwrap();
    (await settings.save('alice', 'p2', { enabled: true }))._unsafeUnwrap();
    (await settings.save('bob', 'p1', { enabled: true }))._unsafeUnwrap();
    const p1 = (await settings.factoryId('alice', 'p1'))._unsafeUnwrap()!;
    const p2 = (await settings.factoryId('alice', 'p2'))._unsafeUnwrap()!;
    const bobs = (await settings.factoryId('bob', 'p1'))._unsafeUnwrap()!;
    // No run was ever admitted to any of these lanes.
    (await lanes.ensure(p1, { name: 'auth', branch: 'feature/auth' }))._unsafeUnwrap();
    (await lanes.ensure(p2, { name: 'auth', branch: 'lane/auth' }))._unsafeUnwrap();
    (await lanes.ensure(bobs, { name: 'billing', branch: 'feature/billing' }))._unsafeUnwrap();

    const listed = (await port.queueLanes('alice'))._unsafeUnwrap();
    expect(listed).toEqual([
      {
        projectId: 'p1',
        name: 'auth',
        label: 'feature:auth',
        branch: 'feature/auth',
        state: 'active',
      },
      { projectId: 'p2', name: 'auth', label: 'lane:auth', branch: 'lane/auth', state: 'active' },
    ]);
    expect((await port.queueLanes('carol'))._unsafeUnwrap()).toEqual([]);
  });

  test('syncLane requests sync for idle, retries needs_human, wakes watcher, and records factory.lane_sync activity', async () => {
    const woken: string[] = [];
    const { github } = makeFakeGithub();
    const { settings, lanes, port } = makePort(github, woken);

    (await settings.save('alice', 'p1', { enabled: true }))._unsafeUnwrap();
    const factoryId = (await settings.factoryId('alice', 'p1'))._unsafeUnwrap()!;
    const lane = (
      await lanes.ensure(factoryId, { name: 'auth', branch: 'feature/auth' })
    )._unsafeUnwrap();

    const first = (await port.syncLane('alice', 'p1', 'auth'))._unsafeUnwrap();
    expect(first).toEqual({ outcome: 'requested' });
    expect(woken).toEqual([factoryId]);

    // Put the lane in needs_human and retry via syncLane.
    testDb.sqlite
      .query(
        "UPDATE factory_lanes SET sync_state = 'needs_human', sync_error = 'conflicts' WHERE id = ?",
      )
      .run(lane.id);

    const retried = (await port.syncLane('alice', 'p1', 'auth'))._unsafeUnwrap();
    expect(retried).toEqual({ outcome: 'retried' });
    expect(woken).toEqual([factoryId, factoryId]);

    const activities = await repos.activities().listByUser('alice');
    expect(activities.some((a) => a.kind === 'factory.lane_sync')).toBe(true);
  });

  test('finishLane refuses while a run is in flight, opens the finish PR listing merged issues, records activity, and returns the same PR on repeat', async () => {
    const woken: string[] = [];
    const { github, opened } = makeFakeGithub();
    const { settings, lanes, runs, port } = makePort(github, woken);

    (await settings.save('alice', 'p1', { enabled: true }))._unsafeUnwrap();
    const factoryId = (await settings.factoryId('alice', 'p1'))._unsafeUnwrap()!;
    (await lanes.ensure(factoryId, { name: 'auth', branch: 'feature/auth' }))._unsafeUnwrap();

    // Seed a merged issue and an in-flight issue on the lane.
    (
      await runs.start({
        factoryId,
        issueNumber: 7,
        issueTitle: 'Add login',
        state: 'merged',
        baseBranch: 'feature/auth',
        lane: 'auth',
      })
    )._unsafeUnwrap();
    const inFlight = (
      await runs.start({
        factoryId,
        issueNumber: 8,
        issueTitle: 'Add logout',
        state: 'working',
        baseBranch: 'feature/auth',
        lane: 'auth',
      })
    )._unsafeUnwrap();

    // Refused while #8 is in flight.
    const refused = await port.finishLane('alice', 'p1', 'auth');
    expect(refused.isErr()).toBe(true);
    expect(refused._unsafeUnwrapErr().status).toBe(400);
    expect(opened).toHaveLength(0);

    // Finish #8, then finish the lane.
    (await runs.updateInFlight(inFlight.id, { state: 'merged' }))._unsafeUnwrap();

    const first = (await port.finishLane('alice', 'p1', 'auth'))._unsafeUnwrap();
    expect(first).toEqual({
      lane: 'auth',
      branch: 'feature/auth',
      base: 'develop',
      prNumber: 50,
      prUrl: 'https://github.com/acme/app/pull/50',
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.head).toBe('feature/auth');
    expect(opened[0]!.base).toBe('develop');
    expect(opened[0]!.body).toContain('#7 Add login');
    expect(opened[0]!.body).toContain('A person must review and merge it');
    expect(woken).toContain(factoryId);

    const listed = (await port.lanes('alice', 'p1'))._unsafeUnwrap();
    expect(listed[0]!.finishPrNumber).toBe(50);
    expect(listed[0]!.finishPrUrl).toBe('https://github.com/acme/app/pull/50');

    const activities = await repos.activities().listByUser('alice');
    expect(activities.some((a) => a.kind === 'factory.finish_lane')).toBe(true);

    // Asking again returns the same open pull request.
    const second = (await port.finishLane('alice', 'p1', 'auth'))._unsafeUnwrap();
    expect(second.prNumber).toBe(50);
  });
});
