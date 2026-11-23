/**
 * The sentinel (change factory-agent-roles, D10): an incident when a base
 * branch turns red after a factory merge, its one-at-a-time rule, the revert
 * of the merge the sentinel names, and how it closes. Real test DB for the
 * incidents; GitHub, the launcher and the notifier are fakes.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import type { CiState } from '@funny/core/github-app';
import type { FactoryIncidentCandidate } from '@funny/shared/contracts/factory';
import { err, ok } from 'neverthrow';

import { createFactoryIncidentsRepository } from '../../../services/factory/factory-incidents.js';
import {
  createFactorySentinel,
  INCIDENT_WINDOW_MS,
  SENTINEL_TIMEOUT_MS,
  type SentinelDeps,
} from '../../../services/factory/factory-sentinel.js';
import { createTestDb } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;

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
});

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const RED: CiState = {
  kind: 'failing',
  checks: [{ name: 'test', conclusion: 'failure', excerpt: 'expected 3, got 2' }],
};
const GREEN: CiState = { kind: 'green' };

const merge = (issueNumber: number, userId = 'alice'): FactoryIncidentCandidate => ({
  issueNumber,
  prUrl: `https://github.com/o/r/pull/${issueNumber + 100}`,
  mergedAt: '2026-11-22T11:00:00.000Z',
  userId,
});

const json = (value: unknown) => ['```json', JSON.stringify(value), '```'].join('\n');

interface World {
  ci: CiState | null;
  merges: FactoryIncidentCandidate[];
  /** What the sentinel's thread says, and how it ended. */
  says: string | null;
  threadStatus: string | null;
  launchFails?: boolean;
  revertFails?: boolean;
  /** The checks of each merged pull request's merge commit; unread (null) when absent. */
  mergeCi?: Record<number, CiState>;
  /** Shared across the world's sentinels, as the watcher shares it across ticks. */
  cleared?: Set<string>;
  now: number;
}

function sentinelFor(world: World, factory = { id: 'f-alice', userId: 'alice', projectId: 'p1' }) {
  const launches: Record<string, unknown>[] = [];
  const reverts: Array<{ pr: number; title: string; body: string }> = [];
  const notices: Array<{ userId: string; body: string }> = [];
  const retired: string[] = [];
  let branchReads = 0;
  const mergeReads: number[] = [];
  const deps: SentinelDeps = {
    // The incidents share the test's clock, so "how long it has been open" is the test's.
    incidents: createFactoryIncidentsRepository({
      newId: () => crypto.randomUUID(),
      now: () => new Date(world.now),
    }),
    recentMerges: async (_repo, since) =>
      world.merges.filter((candidate) => candidate.mergedAt >= since),
    defaultBranch: async () => 'main',
    branchState: async () => {
      branchReads += 1;
      return world.ci ? { sha: 'red-sha-0123456789', ci: world.ci } : null;
    },
    mergeState: async (pr) => {
      mergeReads.push(pr);
      const ci = world.mergeCi?.[pr];
      return ci ? { sha: `merge-sha-${pr}`, ci } : null;
    },
    cleared: world.cleared,
    launch: async (body) => {
      if (world.launchFails) {
        return err({ kind: 'runner-unavailable' as const, status: 502, message: 'runner offline' });
      }
      launches.push(body);
      return ok({ thread: { id: 'sen-1' }, threadId: 'sen-1', runnerId: 'r' });
    },
    threadStatus: async () => world.threadStatus,
    finalMessage: async () => world.says,
    revert: async (pr, text) => {
      reverts.push({ pr, ...text });
      return world.revertFails
        ? err({ message: 'conflicts with later commits' })
        : ok({ url: 'https://github.com/o/r/pull/900' });
    },
    notify: async (userId, notice) => {
      notices.push({ userId, body: notice.body });
    },
    retire: async (threadId) => {
      retired.push(threadId);
    },
    mode: 'worktree',
    now: () => world.now,
  };
  const sentinel = createFactorySentinel(deps, factory, 'o/r');
  return {
    sentinel,
    launches,
    reverts,
    notices,
    mergeReads,
    retired,
    branchReads: () => branchReads,
  };
}

const world = (over: Partial<World> = {}): World => ({
  ci: RED,
  merges: [merge(12)],
  says: null,
  threadStatus: 'running',
  now: NOW,
  ...over,
});

const incidents = () =>
  testDb.sqlite.query('SELECT * FROM factory_incidents ORDER BY opened_at').all() as Array<{
    id: string;
    state: string;
    result: string | null;
    affected_factories: string | null;
    closed_by: string | null;
  }>;

describe('a base branch red after a factory merge', () => {
  test('opens one incident, starts a read-only sentinel and pauses the factory', async () => {
    const { sentinel, launches } = sentinelFor(world());
    const reason = await sentinel.superviseBase();

    expect(reason).toContain('Incident: the base branch main of o/r is red');
    expect(incidents()).toMatchObject([{ state: 'investigating' }]);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      readOnly: true,
      permissionMode: 'plan',
      source: 'factory',
      baseBranch: 'main',
      title: '[Factory sentinel] main red-sha-',
    });
    const prompt = String(launches[0]?.prompt);
    expect(prompt).toContain('https://github.com/o/r/pull/112');
    expect(prompt).toContain('expected 3, got 2');
  });

  test('red long after any factory merge opens nothing, and the branch is not even read', async () => {
    const old = {
      ...merge(12),
      mergedAt: new Date(NOW - INCIDENT_WINDOW_MS - 60_000).toISOString(),
    };
    const { sentinel, branchReads } = sentinelFor(world({ merges: [old] }));
    expect(await sentinel.superviseBase()).toBeNull();
    expect(incidents()).toEqual([]);
    expect(branchReads()).toBe(0);
  });

  test('green after the last factory merge opens nothing, and is not read again', async () => {
    const shared = world({ mergeCi: { 112: GREEN }, cleared: new Set() });
    const first = sentinelFor(shared);
    expect(await first.sentinel.superviseBase()).toBeNull();
    expect(incidents()).toEqual([]);
    expect(first.launches).toEqual([]);
    // The next tick, same red commit and same merges: the merge commit is not read again.
    const next = sentinelFor(shared);
    expect(await next.sentinel.superviseBase()).toBeNull();
    expect(next.mergeReads).toEqual([]);
  });

  test('only the merges after the newest green merge commit are suspects, with their merge commits', async () => {
    const newest = { ...merge(14), mergedAt: '2026-11-22T11:30:00.000Z' };
    const middle = { ...merge(13), mergedAt: '2026-11-22T11:20:00.000Z' };
    const { sentinel, launches, mergeReads } = sentinelFor(
      world({
        merges: [newest, middle, merge(12)],
        mergeCi: { 114: RED, 113: GREEN, 112: RED },
      }),
    );
    await sentinel.superviseBase();
    // Read back to the green one, and no further.
    expect(mergeReads).toEqual([114, 113]);
    const prompt = String(launches[0]?.prompt);
    expect(prompt).toContain('https://github.com/o/r/pull/114');
    expect(prompt).toContain('merge commit merge-sha-114');
    expect(prompt).not.toContain('https://github.com/o/r/pull/113');
    expect(prompt).not.toContain('https://github.com/o/r/pull/112');
  });

  test('a merge commit whose checks cannot be read stays a suspect', async () => {
    const { sentinel, launches } = sentinelFor(world());
    await sentinel.superviseBase();
    expect(String(launches[0]?.prompt)).toContain('https://github.com/o/r/pull/112 (merged');
  });

  test('a branch that is not red opens nothing', async () => {
    for (const ci of [GREEN, { kind: 'pending' } as CiState]) {
      const { sentinel } = sentinelFor(world({ ci }));
      expect(await sentinel.superviseBase()).toBeNull();
    }
    expect(incidents()).toEqual([]);
  });

  test("a second red, seen by another user's factory, opens no second incident and pauses it too", async () => {
    const shared = world();
    await sentinelFor(shared).sentinel.superviseBase();
    const bob = sentinelFor(shared, { id: 'f-bob', userId: 'bob', projectId: 'p2' });
    const reason = await bob.sentinel.superviseBase();

    expect(reason).toContain('Incident');
    expect(incidents()).toHaveLength(1);
    // Bob's factory did not start a second sentinel; it is recorded as paused by this one.
    expect(bob.launches).toEqual([]);
    expect(JSON.parse(incidents()[0]!.affected_factories!)).toEqual(['f-alice', 'f-bob']);
  });

  test('the base branch green again closes the incident and admissions resume', async () => {
    const shared = world();
    const { sentinel } = sentinelFor(shared);
    await sentinel.superviseBase();
    shared.ci = GREEN;
    expect(await sentinel.superviseBase()).toBeNull();
    expect(incidents()).toMatchObject([{ state: 'closed', closed_by: 'green' }]);
    // A new red after that is a new incident.
    shared.ci = RED;
    expect(await sentinel.superviseBase()).toContain('Incident');
    expect(incidents()).toHaveLength(2);
  });

  test('checks still running neither close the incident nor open another', async () => {
    const shared = world();
    const { sentinel } = sentinelFor(shared);
    await sentinel.superviseBase();
    shared.ci = { kind: 'pending' };
    expect(await sentinel.superviseBase()).toContain('Incident');
    expect(incidents()).toHaveLength(1);
  });

  test('a repository that cannot be read keeps a known incident pausing', async () => {
    const shared = world();
    const { sentinel } = sentinelFor(shared);
    await sentinel.superviseBase();
    shared.ci = null;
    expect(await sentinel.superviseBase()).toContain('Incident');
  });
});

describe("the sentinel's answer", () => {
  /** An incident whose sentinel finished saying `says`. */
  async function answered(says: string | null, over: Partial<World> = {}) {
    const shared = world({ merges: [merge(12, 'alice'), merge(13, 'bob')], ...over });
    const run = sentinelFor(shared);
    await run.sentinel.superviseBase();
    shared.says = says;
    shared.threadStatus = over.threadStatus ?? 'completed';
    const reason = await run.sentinel.superviseBase();
    const [incident] = incidents();
    return { ...run, reason, incident: incident!, result: JSON.parse(incident!.result ?? 'null') };
  }

  test('it names a merge: a revert pull request is opened and that run enabler is told', async () => {
    const { reverts, notices, result, incident, reason } = await answered(
      json({ decision: 'revert', culprit: 113, reason: 'It removed the rounding helper.' }),
    );
    expect(reverts).toHaveLength(1);
    expect(reverts[0]).toMatchObject({ pr: 113, title: 'Revert #113: it broke main' });
    expect(reverts[0]?.body).toContain('It does not merge reverts');
    expect(incident.state).toBe('reported');
    expect(result).toEqual({
      decision: 'revert',
      reason: 'It removed the rounding helper.',
      culpritPrUrl: 'https://github.com/o/r/pull/113',
      revertPrUrl: 'https://github.com/o/r/pull/900',
    });
    // Bob's merge: Bob is told, not everyone.
    expect(notices.map((notice) => notice.userId)).toEqual(['bob']);
    // Still paused: the revert is not merged by the factory.
    expect(reason).toContain('A revert is open: https://github.com/o/r/pull/900');
  });

  test('it cannot name one: every affected enabler is told, and nothing is reverted', async () => {
    const { reverts, notices, result } = await answered(
      json({ decision: 'unknown', reason: 'The failing test is flaky.' }),
    );
    expect(reverts).toEqual([]);
    expect(result).toEqual({ decision: 'unknown', reason: 'The failing test is flaky.' });
    expect(notices.map((notice) => notice.userId).sort()).toEqual(['alice', 'bob']);
  });

  test('it finds no factory merge broke it: the incident closes, quietly, and admissions resume', async () => {
    const { notices, incident, result, reason } = await answered(
      json({ decision: 'unrelated', reason: 'ca4df7e19, a direct merge, broke the mock.' }),
    );
    expect(incident).toMatchObject({ state: 'closed', closed_by: 'unrelated' });
    expect(result).toEqual({
      decision: 'unrelated',
      reason: 'ca4df7e19, a direct merge, broke the mock.',
    });
    expect(reason).toBeNull();
    expect(notices).toEqual([]);
  });

  test('after an unrelated answer only a later factory merge opens a new incident', async () => {
    const shared = world({ merges: [merge(12)] });
    const run = sentinelFor(shared);
    await run.sentinel.superviseBase();
    shared.says = json({ decision: 'unrelated', reason: 'A direct push broke it.' });
    shared.threadStatus = 'completed';
    await run.sentinel.superviseBase();
    // Still red, same merges: nothing reopens.
    expect(await run.sentinel.superviseBase()).toBeNull();
    expect(incidents()).toHaveLength(1);
    // A factory merge after it: a new incident, about that merge only.
    shared.now = NOW + 60 * 60 * 1000;
    shared.merges = [
      { ...merge(20), mergedAt: new Date(NOW + 30 * 60 * 1000).toISOString() },
      merge(12),
    ];
    expect(await run.sentinel.superviseBase()).toContain('Incident');
    expect(incidents()).toHaveLength(2);
    const prompt = String(run.launches[1]?.prompt);
    expect(prompt).toContain('https://github.com/o/r/pull/120');
    expect(prompt).not.toContain('https://github.com/o/r/pull/112');
  });

  test('an invalid result escalates to a person', async () => {
    const { reverts, result, notices } = await answered('I think it is the second one.');
    expect(reverts).toEqual([]);
    expect(result.decision).toBe('escalate');
    expect(result.reason).toContain('gave no result');
    expect(notices).toHaveLength(2);
  });

  test('a merge that is not one of the factory candidates is never reverted', async () => {
    const { reverts, result } = await answered(
      json({ decision: 'revert', culprit: 4242, reason: 'Trust me.' }),
    );
    expect(reverts).toEqual([]);
    expect(result.decision).toBe('escalate');
    expect(result.reason).toContain('#4242');
  });

  test('a revert GitHub cannot open is reported without one, to everyone', async () => {
    const { result, notices, reason } = await answered(
      json({ decision: 'revert', culprit: 113, reason: 'It removed the helper.' }),
      { revertFails: true },
    );
    expect(result).toEqual({
      decision: 'revert',
      reason: 'It removed the helper.',
      culpritPrUrl: 'https://github.com/o/r/pull/113',
    });
    expect(notices).toHaveLength(2);
    expect(reason).toContain('A revert could not be opened');
  });

  test('a sentinel thread that failed escalates', async () => {
    const { result, retired } = await answered(null, { threadStatus: 'failed' });
    expect(result.decision).toBe('escalate');
    expect(retired).toEqual(['sen-1']);
  });

  test('its thread is retired once its answer is read, and only then', async () => {
    const { retired } = await answered(json({ decision: 'unknown', reason: 'Flaky.' }));
    expect(retired).toEqual(['sen-1']);
  });

  test('a sentinel still running is waited for, then given up on', async () => {
    const shared = world();
    const run = sentinelFor(shared);
    await run.sentinel.superviseBase();
    await run.sentinel.superviseBase();
    expect(incidents()).toMatchObject([{ state: 'investigating' }]);
    shared.now = NOW + SENTINEL_TIMEOUT_MS + 60_000;
    await run.sentinel.superviseBase();
    expect(incidents()).toMatchObject([{ state: 'reported' }]);
    expect(run.notices).toHaveLength(1);
    // Still running: its checkout stays.
    expect(run.retired).toEqual([]);
  });

  test('a sentinel that cannot start escalates at once', async () => {
    const { sentinel, notices } = sentinelFor(world({ launchFails: true }));
    expect(await sentinel.superviseBase()).toContain('could not name the merge');
    expect(incidents()).toMatchObject([{ state: 'reported' }]);
    expect(notices).toHaveLength(1);
  });

  test("only the factory that opened the incident reads the sentinel's answer", async () => {
    const shared = world();
    await sentinelFor(shared).sentinel.superviseBase();
    shared.says = json({ decision: 'unknown', reason: 'Flaky.' });
    shared.threadStatus = 'completed';
    const bob = sentinelFor(shared, { id: 'f-bob', userId: 'bob', projectId: 'p2' });
    await bob.sentinel.superviseBase();
    expect(incidents()).toMatchObject([{ state: 'investigating' }]);
    expect(bob.notices).toEqual([]);
  });
});

describe('the incident machine', () => {
  const repo = () => createFactoryIncidentsRepository();
  const opened = async () =>
    (
      await repo().open({
        repo: 'o/r',
        baseBranch: 'main',
        redSha: 'abc',
        candidates: [merge(12)],
        factoryId: 'f1',
      })
    )._unsafeUnwrap()!;

  test('one incident that is not closed per repository and base branch', async () => {
    const first = await opened();
    expect(first.state).toBe('open');
    const second = await repo().open({
      repo: 'o/r',
      baseBranch: 'main',
      redSha: 'def',
      candidates: [],
      factoryId: 'f2',
    });
    expect(second._unsafeUnwrap()).toBeNull();
    // Another base branch, or another repository, has its own.
    const other = await repo().open({
      repo: 'o/r',
      baseBranch: 'release',
      redSha: 'def',
      candidates: [],
      factoryId: 'f2',
    });
    expect(other._unsafeUnwrap()).not.toBeNull();
  });

  test('transitions are refused from the wrong state', async () => {
    const incident = await opened();
    expect((await repo().investigating(incident.id, 't1'))._unsafeUnwrap()).toBe(true);
    // Already investigating: not started twice.
    expect((await repo().investigating(incident.id, 't2'))._unsafeUnwrap()).toBe(false);
    expect(
      (await repo().report(incident.id, { decision: 'unknown', reason: '?' }))._unsafeUnwrap(),
    ).toBe(true);
    expect(
      (await repo().report(incident.id, { decision: 'unknown', reason: '!' }))._unsafeUnwrap(),
    ).toBe(false);
    expect((await repo().close(incident.id, 'alice'))._unsafeUnwrap()).toBe(true);
    // Closed is final: nothing moves it, and it is closed once.
    expect((await repo().close(incident.id, 'bob'))._unsafeUnwrap()).toBe(false);
    expect(
      (await repo().report(incident.id, { decision: 'unknown', reason: '!' }))._unsafeUnwrap(),
    ).toBe(false);
    const stored = (await repo().get(incident.id))._unsafeUnwrap()!;
    expect(stored).toMatchObject({ state: 'closed', sentinelThreadId: 't1' });
    expect(stored.result).toEqual({ decision: 'unknown', reason: '?' });
  });

  test('the incident that paused a factory is found by that factory', async () => {
    const incident = await opened();
    await repo().noteAffected(incident, 'f2');
    expect((await repo().activeForFactory('f2'))._unsafeUnwrap()?.id).toBe(incident.id);
    expect((await repo().activeForFactory('f3'))._unsafeUnwrap()).toBeNull();
    await repo().close(incident.id, 'green');
    expect((await repo().activeForFactory('f2'))._unsafeUnwrap()).toBeNull();
  });
});
