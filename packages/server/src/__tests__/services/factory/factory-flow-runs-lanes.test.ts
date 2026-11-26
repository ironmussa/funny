/**
 * Cross-lane merge concurrency (openspec factory-lanes 4.4): two runs on
 * different lanes reach `merge` at once and each takes its own merge lane
 * (`merge:<repo>:feature/a`, `merge:<repo>:feature/b`).
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { createMemoryConcurrencyGate, type ConcurrencyGate } from '@funny/pipelines';
import { okAsync, ResultAsync } from 'neverthrow';

import { createFactoryFlowRuns } from '../../../services/factory/factory-flow-runs.js';
import { loadFactoryFlow } from '../../../services/factory/factory-flow.js';
import type { FactoryGithubPort } from '../../../services/factory/factory-github.js';
import { createFactoryRunsRepository } from '../../../services/factory/factory-runs.js';
import {
  createFactorySettingsService,
  listEnabledFactories,
} from '../../../services/factory/factory-settings.js';
import { createTestDb, seedProject } from '../../helpers/test-db.js';

const MERGE_ONLY_YAML = `
name: merge-only
nodes:
  - id: merge
    merge:
      method: squash
      delete_branch: true
      require_review: false
      require_regression_proof: false
`;

/** A deferred promise for synchronizing two concurrent merge steps. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('factory flow runs across lanes (openspec factory-lanes 4.4)', () => {
  beforeEach(async () => {
    const testDb = createTestDb();
    const { setConnection } = await import('../../../db/index.js');
    setConnection({
      db: testDb.db,
      schema: testDb.schema,
      sqlite: testDb.sqlite,
      mode: 'sqlite',
      close: async () => testDb.sqlite.close(),
    });
    seedProject(testDb.db, { id: 'p1', userId: 'alice', name: 'Repo', path: '/tmp/repo' });
  });

  test('two runs of different lanes reach merge at once and each takes its own merge lane', async () => {
    const settings = createFactorySettingsService();
    (
      await settings.save('alice', 'p1', {
        enabled: true,
        mode: 'automatic',
        label: 'ready-for-agent',
        flowName: 'merge-only',
        maxConcurrent: 4,
        batch: { size: 1, waitSeconds: 0 },
      })
    )._unsafeUnwrap();
    const [factory] = await listEnabledFactories();
    expect(factory).toBeDefined();

    const runs = createFactoryRunsRepository();
    const runA = (
      await runs.start({
        factoryId: factory!.id,
        issueNumber: 1,
        issueTitle: 'Lane A issue',
        state: 'pr_open',
        baseBranch: 'feature/a',
        lane: 'a',
      })
    )._unsafeUnwrap();
    const runB = (
      await runs.start({
        factoryId: factory!.id,
        issueNumber: 2,
        issueTitle: 'Lane B issue',
        state: 'pr_open',
        baseBranch: 'feature/b',
        lane: 'b',
      })
    )._unsafeUnwrap();

    (await runs.update(runA.id, { prUrl: 'https://github.com/o/r/pull/11' }))._unsafeUnwrap();
    (await runs.update(runB.id, { prUrl: 'https://github.com/o/r/pull/22' }))._unsafeUnwrap();
    const fullA = (await runs.get(runA.id))._unsafeUnwrap()!;
    const fullB = (await runs.get(runB.id))._unsafeUnwrap()!;

    // Wrap the real memory gate so we can inspect the exact concurrency groups
    // held simultaneously when both runs reach `merge`.
    const inner = createMemoryConcurrencyGate();
    const heldNow = new Set<string>();
    const acquiredGroups: string[] = [];
    const bothInMerge = deferred();
    const releaseMerge = deferred();
    let maxConcurrentMerges = 0;

    const spyGate: ConcurrencyGate = {
      async acquire(opts) {
        acquiredGroups.push(opts.group);
        const grant = await inner.acquire(opts);
        if (grant.kind !== 'slot') return grant;
        heldNow.add(opts.group);
        return {
          ...grant,
          release: () => {
            heldNow.delete(opts.group);
            grant.release();
          },
        };
      },
    };

    const inMerge = new Set<number>();
    // SAFETY: the flow runs call only the methods below; the rest of the port is never reached.
    const github: FactoryGithubPort = {
      defaultBranch: (reader: { baseBranch?: string | null }) =>
        okAsync(reader.baseBranch ?? 'main'),
      branchAhead: () => okAsync(true),
      commentOnIssue: () => okAsync(undefined),
      closeIssue: () => okAsync(undefined),
      findPullRequest: () => okAsync(null),
      pullRequests: {
        prState: () => okAsync('open' as const),
        changedFiles: () => okAsync({ files: [], truncated: false }),
        publishReview: () => okAsync({ status: true }),
        baseDistance: () => okAsync({ behindBy: 0, aheadBy: 1 }),
        updateBranch: () => okAsync({ kind: 'updating' as const }),
        commitParents: () => okAsync([]),
        baseChanges: () => okAsync({ commits: [], files: [] }),
        mergeQueueRequired: () => okAsync(false),
        enqueue: () => okAsync({ kind: 'queued' as const }),
        queueState: () => okAsync('merged' as const),
        pullHead: (pr: { number: number }) =>
          okAsync({
            sha: `head-${pr.number}`,
            baseRef: pr.number === 11 ? 'feature/a' : 'feature/b',
            autoMerge: false,
          }),
        publishProofCheck: () => okAsync(undefined),
        ciState: () => okAsync({ kind: 'green' as const }),
        merge: (pr: { number: number }) => {
          inMerge.add(pr.number);
          maxConcurrentMerges = Math.max(maxConcurrentMerges, inMerge.size);
          if (inMerge.size === 2) bothInMerge.resolve();
          return ResultAsync.fromSafePromise(
            releaseMerge.promise.then(() => {
              inMerge.delete(pr.number);
              return {
                kind: 'merged' as const,
                method: 'squash' as const,
                branchDeleted: true,
              };
            }),
          );
        },
      },
    } as never;

    const flowRuns = createFactoryFlowRuns({
      runs,
      github,
      gate: spyGate,
      launch: async () => {
        throw new Error('no agent expected');
      },
      loadFlow: (_job, context) =>
        loadFactoryFlow(
          'merge-only',
          {
            readDefaultBranchFile: async (path) =>
              path === '.funny/workflows/merge-only.yml' ? okAsync(MERGE_ONLY_YAML) : okAsync(null),
          },
          context,
        ),
    });

    const jobA = {
      factory: factory!,
      repo: 'o/r',
      mode: 'local' as const,
      issue: {
        number: 1,
        title: 'Lane A issue',
        url: 'https://github.com/o/r/issues/1',
        labels: ['feature:a'],
      },
      run: fullA,
    };
    const jobB = {
      factory: factory!,
      repo: 'o/r',
      mode: 'local' as const,
      issue: {
        number: 2,
        title: 'Lane B issue',
        url: 'https://github.com/o/r/issues/2',
        labels: ['feature:b'],
      },
      run: fullB,
    };

    const startA = flowRuns.start(jobA);
    const startB = flowRuns.start(jobB);

    // Wait until BOTH runs are inside `merge` at the same time.
    const reached = await Promise.race([
      bothInMerge.promise.then(() => 'both' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1000)),
    ]);
    if (reached !== 'both') {
      const a = (await runs.get(runA.id))._unsafeUnwrap();
      const b = (await runs.get(runB.id))._unsafeUnwrap();
      throw new Error(
        `Timed out before both entered merge: acquired=${JSON.stringify(acquiredGroups)} held=${JSON.stringify([...heldNow])} inMerge=${JSON.stringify([...inMerge])} activeA=${flowRuns.isActive(runA.id)} activeB=${flowRuns.isActive(runB.id)} A=${a?.state}/${a?.failureReason} B=${b?.state}/${b?.failureReason}`,
      );
    }
    expect(maxConcurrentMerges).toBe(2);
    expect([...heldNow].sort()).toEqual(['merge:o/r:feature/a', 'merge:o/r:feature/b']);

    releaseMerge.resolve();
    await Promise.all([startA, startB]);
    const deadline = Date.now() + 5000;
    while ((flowRuns.isActive(runA.id) || flowRuns.isActive(runB.id)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await flowRuns.stopAll();

    expect(acquiredGroups.sort()).toEqual(['merge:o/r:feature/a', 'merge:o/r:feature/b']);
    expect((await runs.get(runA!.id))._unsafeUnwrap()?.state).toBe('merged');
    expect((await runs.get(runB!.id))._unsafeUnwrap()?.state).toBe('merged');
  });
});
