/**
 * A lane's sync with the branch its factory merges into (openspec
 * factory-lanes, D4): the transition table, and the steps over a fake GitHub
 * with the lane row in a real test database (the moves are compare-and-set).
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import type { CiState } from '@funny/core/github-app';
import { errAsync, okAsync } from 'neverthrow';

import {
  createLaneSync,
  LANE_SYNC_MIN_INTERVAL_MS,
  LANE_SYNC_NO_CHECKS_MS,
  LANE_SYNC_TRANSITIONS,
  nextLaneSyncState,
  type LaneSyncDeps,
  type LaneSyncState,
} from '../../../services/factory/factory-lane-sync.js';
import { createFactoryLanesRepository } from '../../../services/factory/factory-lanes.js';
import type { FactoryMergeOutcome } from '../../../services/factory/factory-pull-requests.js';
import { createFactorySettingsService } from '../../../services/factory/factory-settings.js';
import { present } from '../../helpers/builders-services.js';
import { createTestDb, seedProject } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
let factoryId: string;
const lanes = createFactoryLanesRepository();
const T0 = Date.parse('2026-11-26T10:00:00Z');

beforeEach(async () => {
  testDb = createTestDb();
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  const settings = createFactorySettingsService();
  (await settings.save('alice', 'p1', { enabled: true, baseBranch: 'dev' }))._unsafeUnwrap();
  factoryId = present((await settings.factoryId('alice', 'p1'))._unsafeUnwrap(), 'a factory');
  (await lanes.ensure(factoryId, { name: 'a', branch: 'feature/a' }))._unsafeUnwrap();
});

/** A fake repository: branch heads, which branch contains which commit, and what GitHub answers. */
function world(
  over: {
    merge?: 'merged' | 'nothing' | 'conflict';
    ci?: CiState;
    outcome?: FactoryMergeOutcome;
    holders?: string[];
    /** The factory has an agent for the syncs it cannot settle itself. */
    agent?: boolean;
  } = {},
) {
  const state = {
    heads: { dev: 'dev-2', 'feature/a': 'a-1' } as Record<string, string>,
    contains: {} as Record<string, string[]>,
    merge: over.merge ?? ('merged' as const),
    ci: over.ci ?? ({ kind: 'green' } as CiState),
    outcome:
      over.outcome ??
      ({ kind: 'merged', method: 'merge', branchDeleted: true } as FactoryMergeOutcome),
    holders: over.holders ?? [],
    now: T0,
    calls: [] as string[],
    merges: [] as Array<{ number: number; sha?: string; method?: string }>,
    turns: [] as string[],
    /** The agent's thread: its status and when its last turn ended. */
    thread: null as { status: string; completedAt: string | null } | null,
    started: [] as Array<{ branch: string; baseBranch: string; prompt: string }>,
    followUps: [] as string[],
  };
  const deps: LaneSyncDeps = {
    lanes,
    now: () => state.now,
    baseBranch: async () => 'dev',
    branches: {
      branchHead: (branch) => okAsync(state.heads[branch] ?? null),
      branchContains: (branch, sha) => okAsync(state.contains[sha]?.includes(branch) ?? false),
      resetBranch: (branch, sha) => {
        state.calls.push(`reset ${branch} ${sha}`);
        state.heads[branch] = sha;
        return okAsync(undefined);
      },
      mergeInto: (branch, sha) => {
        state.calls.push(`merge ${sha} into ${branch}`);
        return okAsync(state.merge);
      },
      openPullRequest: (input) => {
        state.calls.push(`pr ${input.head} -> ${input.base}`);
        return okAsync(77);
      },
      deleteBranch: (branch) => {
        state.calls.push(`delete ${branch}`);
        return okAsync(undefined);
      },
    },
    pullRequests: {
      ciState: () => okAsync(state.ci),
      pullHead: () => okAsync({ sha: 'sync-head', baseRef: 'feature/a', autoMerge: false }),
      merge: (pr, options) => {
        state.merges.push({ number: pr.number, sha: options?.sha, method: options?.method });
        return okAsync(state.outcome);
      },
    },
    mergeTurn: {
      holders: async () => [...state.holders],
      take: async (group, holder) => {
        state.turns.push(`take ${group}`);
        state.holders.push(holder);
      },
      release: async (group, holder) => {
        state.turns.push(`release ${group}`);
        state.holders = state.holders.filter((one) => one !== holder);
      },
    },
  };
  if (over.agent) {
    deps.agent = {
      start: async (input) => {
        state.started.push(input);
        state.thread = { status: 'running', completedAt: null };
        return { threadId: 't-sync' };
      },
      followUp: async (_threadId, content) => {
        state.followUps.push(content);
        return true;
      },
      turn: async () => state.thread,
    };
  }
  const sync = createLaneSync(deps, {
    factoryId,
    reader: { repo: 'o/r', ownerId: 'alice', projectId: 'p1' },
  });
  return { state, sync, deps };
}

const lane = async () => present((await lanes.find(factoryId, 'a'))._unsafeUnwrap(), 'the lane');

describe('the lane sync transitions', () => {
  test.each([
    ['idle', 'start', 'merging'],
    ['merging', 'clean', 'checking'],
    ['merging', 'nothing', 'idle'],
    ['checking', 'merged', 'idle'],
    ['merging', 'conflict', 'resolving'],
    ['checking', 'red', 'resolving'],
    ['resolving', 'again', 'resolving'],
    ['resolving', 'resolved', 'checking'],
    ['resolving', 'fail', 'needs_human'],
    ['merging', 'fail', 'needs_human'],
    ['checking', 'fail', 'needs_human'],
    ['needs_human', 'retry', 'merging'],
    ['needs_human', 'settle', 'idle'],
  ] as const)('%s --%s--> %s', (from, event, to) => {
    expect(nextLaneSyncState(from, event)).toBe(to);
  });

  test('an event does not apply from a state it does not leave', () => {
    expect(nextLaneSyncState('checking', 'start')).toBeNull();
    expect(nextLaneSyncState('idle', 'merged')).toBeNull();
    expect(nextLaneSyncState('idle', 'retry')).toBeNull();
    const states: LaneSyncState[] = ['idle', 'merging', 'resolving', 'checking', 'needs_human'];
    for (const move of Object.values(LANE_SYNC_TRANSITIONS)) {
      expect(states).toContain(move.to);
    }
  });

  test('two starts at once: one makes the move', async () => {
    const { id } = await lane();
    const [first, second] = await Promise.all([
      lanes.moveSync(id, LANE_SYNC_TRANSITIONS.start),
      lanes.moveSync(id, LANE_SYNC_TRANSITIONS.start),
    ]);
    expect([first._unsafeUnwrap(), second._unsafeUnwrap()].sort()).toEqual([false, true]);
  });
});

describe('a lane sync', () => {
  test('the base moved: its head is merged on a scratch branch and a pull request opens', async () => {
    const { state, sync } = world();
    await sync.tick();

    expect(state.calls).toEqual([
      'reset factory/sync/a a-1',
      'merge dev-2 into factory/sync/a',
      'pr factory/sync/a -> feature/a',
    ]);
    expect(await lane()).toMatchObject({
      syncState: 'checking',
      syncBaseSha: 'dev-2',
      syncPrNumber: 77,
    });
  });

  test('green checks: merged with a merge commit, in the turn of the lane, and the lane is in sync', async () => {
    const { state, sync } = world();
    await sync.tick();
    await sync.tick();

    expect(state.merges).toEqual([{ number: 77, sha: 'sync-head', method: 'merge' }]);
    expect(state.turns).toEqual(['take merge:o/r:feature/a', 'release merge:o/r:feature/a']);
    expect(state.calls.at(-1)).toBe('delete factory/sync/a');
    expect(await lane()).toMatchObject({
      syncState: 'idle',
      lastSyncedBaseSha: 'dev-2',
      syncPrNumber: null,
      syncError: null,
    });
  });

  test('a lane that already contains the base head starts nothing', async () => {
    const { state, sync } = world();
    state.contains['dev-2'] = ['feature/a'];
    await sync.tick();
    expect(state.calls).toEqual([]);
    expect(await lane()).toMatchObject({ syncState: 'idle', lastSyncedBaseSha: 'dev-2' });
  });

  test('the base moving again within the hour waits for the hour', async () => {
    const { state, sync } = world();
    await sync.tick();
    await sync.tick();
    state.heads.dev = 'dev-3';
    state.now = T0 + LANE_SYNC_MIN_INTERVAL_MS - 1000;
    await sync.tick();
    expect(await lane()).toMatchObject({ syncState: 'idle', lastSyncedBaseSha: 'dev-2' });

    state.now = T0 + LANE_SYNC_MIN_INTERVAL_MS + 1000;
    await sync.tick();
    expect(await lane()).toMatchObject({ syncState: 'checking', syncBaseSha: 'dev-3' });
  });

  test('checks still running: nothing is merged yet', async () => {
    const { state, sync } = world({ ci: { kind: 'pending' } });
    await sync.tick();
    await sync.tick();
    expect(state.merges).toEqual([]);
    expect((await lane()).syncState).toBe('checking');
  });

  test('a conflict waits for a person, and goes on once the lane contains the base', async () => {
    const { state, sync } = world({ merge: 'conflict' });
    await sync.tick();
    const stuck = await lane();
    expect(stuck.syncState).toBe('needs_human');
    expect(stuck.syncError).toContain('conflicts');
    // No pull request: there is nothing to open one from.
    expect(state.calls.filter((call) => call.startsWith('pr '))).toEqual([]);

    // No other sync starts while it waits.
    state.now = T0 + 2 * LANE_SYNC_MIN_INTERVAL_MS;
    await sync.tick();
    expect((await lane()).syncState).toBe('needs_human');

    // A person merged dev into feature/a by hand.
    state.contains['dev-2'] = ['feature/a'];
    await sync.tick();
    expect(await lane()).toMatchObject({
      syncState: 'idle',
      lastSyncedBaseSha: 'dev-2',
      syncError: null,
    });
  });

  test('failing checks wait for a person, with the checks named', async () => {
    const { sync } = world({
      ci: {
        kind: 'failing',
        checks: [{ name: 'test', url: 'u', conclusion: 'failure' }],
      } as CiState,
    });
    await sync.tick();
    await sync.tick();
    const stuck = await lane();
    expect(stuck.syncState).toBe('needs_human');
    expect(stuck.syncError).toContain('test');
  });

  test('no check at all: waits a while, then says the workflows may not run for the branch', async () => {
    const { state, sync } = world({ ci: { kind: 'none' } });
    await sync.tick();
    await sync.tick();
    expect((await lane()).syncState).toBe('checking');

    state.now = T0 + LANE_SYNC_NO_CHECKS_MS + 1000;
    await sync.tick();
    const stuck = await lane();
    expect(stuck.syncState).toBe('needs_human');
    expect(stuck.syncError).toContain('feature/a');
  });

  test('a repository that refuses merge commits is reported, never squashed', async () => {
    const { state, sync } = world({
      outcome: { kind: 'not-mergeable', reason: 'Merge commits are not allowed' },
    });
    await sync.tick();
    await sync.tick();
    expect(state.merges.every((merge) => merge.method === 'merge')).toBe(true);
    const stuck = await lane();
    expect(stuck.syncState).toBe('needs_human');
    expect(stuck.syncError).toContain('merge commits');
  });

  test('a run of the lane holds the merge group: the sync waits for its turn', async () => {
    const { state, sync } = world({ holders: ['run-1'] });
    await sync.tick();
    await sync.tick();
    expect(state.merges).toEqual([]);
    expect((await lane()).syncState).toBe('checking');

    state.holders = [];
    await sync.tick();
    expect(state.merges).toHaveLength(1);
    expect((await lane()).syncState).toBe('idle');
  });

  test('a sync in flight resumes from the lane row after a restart', async () => {
    const first = world();
    await first.sync.tick();
    // A new process: nothing in memory, only the row.
    const second = world();
    await second.sync.tick();
    expect(second.state.merges).toEqual([{ number: 77, sha: 'sync-head', method: 'merge' }]);
    expect((await lane()).syncState).toBe('idle');
  });

  test('a finished lane is not synced', async () => {
    testDb.sqlite.run(`UPDATE factory_lanes SET state = 'finished'`);
    const { state, sync } = world();
    await sync.tick();
    expect(state.calls).toEqual([]);
  });

  test('GitHub unreadable: the lane stays where it is', async () => {
    const { deps } = world();
    const sync = createLaneSync(
      { ...deps, branches: { ...deps.branches, branchHead: () => errAsync({ message: '502' }) } },
      { factoryId, reader: { repo: 'o/r', ownerId: 'alice', projectId: 'p1' } },
    );
    await sync.tick();
    expect((await lane()).syncState).toBe('idle');
  });
});

describe('a lane sync the server cannot settle', () => {
  const failing: CiState = {
    kind: 'failing',
    checks: [{ name: 'test', conclusion: 'failure', excerpt: 'expected 3, got 2' }],
  };

  test('a conflict starts one agent on the scratch branch, and its pushed merge goes to the checks', async () => {
    const { state, sync } = world({ merge: 'conflict', agent: true });
    await sync.tick();

    expect(state.started).toHaveLength(1);
    expect(state.started[0]).toMatchObject({ branch: 'factory/sync/a', baseBranch: 'feature/a' });
    expect(state.started[0]!.prompt).toContain('origin/dev');
    expect(state.started[0]!.prompt).toContain('never a rebase');
    expect(await lane()).toMatchObject({
      syncState: 'resolving',
      syncThreadId: 't-sync',
      syncAttempts: 1,
    });

    // Still working: nothing happens.
    await sync.tick();
    expect((await lane()).syncState).toBe('resolving');

    // Its turn ended with the merge pushed.
    state.thread = { status: 'completed', completedAt: '2026-11-26T10:05:00Z' };
    state.contains['dev-2'] = ['factory/sync/a'];
    await sync.tick();
    expect(await lane()).toMatchObject({ syncState: 'checking', syncPrNumber: 77 });

    await sync.tick();
    expect(state.merges).toEqual([{ number: 77, sha: 'sync-head', method: 'merge' }]);
    expect((await lane()).syncState).toBe('idle');
  });

  test('a turn that ended without the merge pushed is asked again, once per turn', async () => {
    const { state, sync } = world({ merge: 'conflict', agent: true });
    await sync.tick();
    state.thread = { status: 'completed', completedAt: '2026-11-26T10:05:00Z' };
    await sync.tick();
    expect(state.followUps).toHaveLength(1);
    expect(state.followUps[0]).toContain('was not pushed');
    expect(await lane()).toMatchObject({ syncState: 'resolving', syncAttempts: 2 });

    // The same ended turn, looked at again before the follow-up's turn ends: not counted twice.
    await sync.tick();
    await sync.tick();
    expect(state.followUps).toHaveLength(1);
    expect((await lane()).syncAttempts).toBe(2);
  });

  test('after three turns without the merge, a person is asked', async () => {
    const { state, sync } = world({ merge: 'conflict', agent: true });
    await sync.tick();
    for (const minute of [5, 10, 15]) {
      state.thread = { status: 'completed', completedAt: `2026-11-26T10:${minute}:00Z` };
      await sync.tick();
    }
    const stuck = await lane();
    expect(stuck.syncState).toBe('needs_human');
    expect(stuck.syncError).toContain('3 attempts');
    expect(state.followUps).toHaveLength(2);
  });

  test('failing checks after a clean merge go to the agent, then back to the checks', async () => {
    const { state, sync } = world({ ci: failing, agent: true });
    await sync.tick();
    await sync.tick();

    expect(state.started).toHaveLength(1);
    expect(state.started[0]!.prompt).toContain('expected 3, got 2');
    expect(await lane()).toMatchObject({ syncState: 'resolving', syncPrNumber: 77 });

    // The clean merge is on the scratch branch already; the agent pushed a fix.
    state.thread = { status: 'completed', completedAt: '2026-11-26T10:05:00Z' };
    state.contains['dev-2'] = ['factory/sync/a'];
    state.ci = { kind: 'green' };
    await sync.tick();
    expect((await lane()).syncState).toBe('checking');
    await sync.tick();
    expect((await lane()).syncState).toBe('idle');
  });

  test('checks still failing after the agent fixed them use up its attempts', async () => {
    const { state, sync } = world({ ci: failing, agent: true });
    state.contains['dev-2'] = ['factory/sync/a'];
    await sync.tick();
    for (const minute of [5, 10, 15]) {
      await sync.tick(); // checking: red, asks the agent
      state.thread = { status: 'completed', completedAt: `2026-11-26T10:${minute}:00Z` };
      await sync.tick(); // resolving: pushed, back to the checks
    }
    await sync.tick();
    const stuck = await lane();
    expect(stuck.syncState).toBe('needs_human');
    expect(stuck.syncError).toContain('3 attempts');
  });

  test('an agent that cannot start, or whose thread is gone, leaves it to a person', async () => {
    const first = world({ merge: 'conflict', agent: true });
    first.deps.agent!.start = async () => ({ error: 'the runner is offline' });
    await first.sync.tick();
    expect((await lane()).syncError).toContain('the runner is offline');

    testDb.sqlite.run(
      `UPDATE factory_lanes SET sync_state = 'resolving', sync_thread_id = 't-gone', sync_base_sha = 'dev-2'`,
    );
    const second = world({ agent: true });
    await second.sync.tick();
    expect(await lane()).toMatchObject({ syncState: 'needs_human' });
  });

  test('an agent that never finishes is given up on', async () => {
    const { state, sync } = world({ merge: 'conflict', agent: true });
    await sync.tick();
    state.now = T0 + 4 * 60 * 60 * 1000;
    await sync.tick();
    const stuck = await lane();
    expect(stuck.syncState).toBe('needs_human');
    expect(stuck.syncError).toContain('in time');
  });
});
