/**
 * The pull requests a merged run supersedes (openspec
 * factory-close-superseded-prs): which ones, and which are left open.
 */
import { describe, expect, test } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

import type { FactoryRunView } from '../../../services/factory/factory-runs-model.js';
import {
  closeSupersededPullRequests,
  recordedHeads,
  supersededPullRequests,
} from '../../../services/factory/factory-superseded.js';

const run = (over: Partial<FactoryRunView> & { id: string }): FactoryRunView =>
  ({
    issueNumber: 489,
    state: 'stopped',
    prUrl: null,
    reviews: [],
    risk: null,
    mergeApproval: null,
    regressionProof: null,
    ...over,
  }) as FactoryRunView;

const proved = (sha: string) =>
  ({ headSha: sha, verdict: 'pass', ranAt: '2026-11-24T10:00:00Z' }) as const;

const merged = run({
  id: 'bbbbbbbb-2222',
  state: 'merged',
  prUrl: 'https://github.com/o/r/pull/511',
});
const stopped = run({
  id: 'aaaaaaaa-1111',
  prUrl: 'https://github.com/o/r/pull/506',
  regressionProof: proved('sha-506'),
});

describe('supersededPullRequests', () => {
  test("is the issue's stopped and failed runs with a pull request of their own", () => {
    const failed = run({
      id: 'cccccccc-3333',
      state: 'failed',
      prUrl: 'https://github.com/o/r/pull/507',
    });
    const found = supersededPullRequests(merged, [merged, stopped, failed]);
    expect(found.map((f) => f.number)).toEqual([506, 507]);
  });

  test('skips runs in flight or parked, other issues, no pull request, or the same pull request', () => {
    const runs = [
      run({ id: 'd1', state: 'waiting_human', prUrl: 'https://github.com/o/r/pull/1' }),
      run({ id: 'd2', state: 'working', prUrl: 'https://github.com/o/r/pull/2' }),
      run({ id: 'd3', issueNumber: 490, prUrl: 'https://github.com/o/r/pull/3' }),
      run({ id: 'd4' }),
      run({ id: 'd5', prUrl: merged.prUrl }),
      run({ id: 'd6', state: 'no_change', prUrl: 'https://github.com/o/r/pull/6' }),
    ];
    expect(supersededPullRequests(merged, runs)).toEqual([]);
  });

  test('a run that did not merge, or has no issue, supersedes nothing', () => {
    expect(supersededPullRequests({ ...merged, state: 'stopped' }, [stopped])).toEqual([]);
    expect(
      supersededPullRequests({ ...merged, issueNumber: null }, [{ ...stopped, issueNumber: null }]),
    ).toEqual([]);
  });
});

test('recordedHeads are the commits reviewed, classified, proved or approved', () => {
  const heads = recordedHeads(
    run({
      id: 'e1',
      reviews: [{ sha: 'sha-r' }] as FactoryRunView['reviews'],
      risk: { headSha: 'sha-k' } as FactoryRunView['risk'],
      regressionProof: proved('sha-p'),
      mergeApproval: { sha: 'sha-a' } as FactoryRunView['mergeApproval'],
    }),
  );
  expect([...heads].sort()).toEqual(['sha-a', 'sha-k', 'sha-p', 'sha-r']);
});

describe('closeSupersededPullRequests', () => {
  const owner = { userId: 'alice', projectId: 'p1', repo: 'o/r' };

  function pullRequests(opts: {
    states?: Record<number, 'open' | 'merged' | 'closed'>;
    heads?: Record<number, string>;
    refuse?: number[];
  }) {
    const closed: Array<{ number: number; branch?: string; by: unknown; origin?: string }> = [];
    return {
      closed,
      port: {
        prState: (pr: { number: number }) => okAsync(opts.states?.[pr.number] ?? 'open'),
        pullHead: (pr: { number: number }) =>
          okAsync({
            sha: opts.heads?.[pr.number] ?? 'sha-none',
            baseRef: 'master',
            autoMerge: false,
          }),
        closeReplaced: (
          pr: { number: number; branch?: string },
          by: unknown,
          origin?: 'user' | 'system',
        ) => {
          if (opts.refuse?.includes(pr.number)) {
            return errAsync({ kind: 'github-error' as const, message: 'GitHub said no' });
          }
          closed.push({ number: pr.number, branch: pr.branch, by, origin });
          return okAsync({ kind: 'closed' as const, branchDeleted: true });
        },
      },
    };
  }

  test("closes a stopped run's open pull request, as the factory, naming the merged one", async () => {
    const { closed, port } = pullRequests({ heads: { 506: 'sha-506' } });
    const outcomes = await closeSupersededPullRequests(
      { owner, runs: [merged, stopped], pullRequests: port },
      merged,
    );
    expect(outcomes).toEqual([{ number: 506, kind: 'closed' }]);
    expect(closed).toEqual([
      {
        number: 506,
        branch: 'factory/issue-489-aaaaaaaa',
        by: { issueNumber: 489, prNumber: 511 },
        origin: 'system',
      },
    ]);
  });

  test('leaves a pull request somebody pushed to, or one no longer open', async () => {
    const other = run({
      id: 'ffffffff-6666',
      prUrl: 'https://github.com/o/r/pull/502',
      regressionProof: proved('sha-502'),
    });
    const { closed, port } = pullRequests({
      heads: { 506: 'sha-pushed', 502: 'sha-502' },
      states: { 502: 'closed' },
    });
    const outcomes = await closeSupersededPullRequests(
      { owner, runs: [merged, stopped, other], pullRequests: port },
      merged,
    );
    expect(outcomes).toEqual([
      { number: 506, kind: 'head-moved', head: 'sha-pushed' },
      { number: 502, kind: 'not-open' },
    ]);
    expect(closed).toEqual([]);
  });

  test('a run that recorded no commit keeps its pull request', async () => {
    const bare = run({ id: 'gggggggg-7777', prUrl: 'https://github.com/o/r/pull/9' });
    const { closed, port } = pullRequests({ heads: { 9: 'sha-9' } });
    await closeSupersededPullRequests({ owner, runs: [merged, bare], pullRequests: port }, merged);
    expect(closed).toEqual([]);
  });

  test('one refused close does not stop the next', async () => {
    const next = run({
      id: 'hhhhhhhh-8888',
      prUrl: 'https://github.com/o/r/pull/507',
      regressionProof: proved('sha-507'),
    });
    const { closed, port } = pullRequests({
      heads: { 506: 'sha-506', 507: 'sha-507' },
      refuse: [506],
    });
    const outcomes = await closeSupersededPullRequests(
      { owner, runs: [merged, stopped, next], pullRequests: port },
      merged,
    );
    expect(outcomes).toEqual([
      { number: 506, kind: 'failed', error: 'GitHub said no' },
      { number: 507, kind: 'closed' },
    ]);
    expect(closed.map((c) => c.number)).toEqual([507]);
  });
});
