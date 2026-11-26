/**
 * `wait_ci` and `merge` of a factory run over a scripted pull request port:
 * the three CI verdicts (green, red, timeout), the no-checks grace period,
 * both merge outcomes, and the actionable error without App access.
 */
import { describe, expect, test } from 'bun:test';

import type { CiState } from '@funny/core/github-app';
import { errAsync, okAsync } from 'neverthrow';

import {
  createFactoryCiActions,
  MERGE_PENDING_TIMEOUT_MS,
  NO_CHECKS_GRACE_MS,
} from '../../../services/factory/factory-ci-actions.js';
import type {
  FactoryMergeOutcome,
  FactoryPullRequestError,
  FactoryPullRequests,
} from '../../../services/factory/factory-pull-requests.js';

const pr = { repo: 'o/r', number: 7, userId: 'alice', projectId: 'p1' };

/**
 * A port that answers `ciState` from a script (last answer repeats) and `merge`
 * with `outcome`, or with each outcome of a list in turn (the last repeats).
 */
function scripted(
  states: Array<CiState | FactoryPullRequestError>,
  outcome: FactoryMergeOutcome | FactoryMergeOutcome[] = {
    kind: 'merged',
    method: 'squash',
    branchDeleted: false,
  },
) {
  const outcomes = Array.isArray(outcome) ? outcome : [outcome];
  let polls = 0;
  const merges: unknown[] = [];
  const prs: FactoryPullRequests = {
    prState: () => okAsync('open'),
    changedFiles: () => okAsync({ files: [], truncated: false }),
    publishReview: () => okAsync({ status: true }),
    baseDistance: () => okAsync({ behindBy: 0, aheadBy: 1 }),
    updateBranch: () => okAsync({ kind: 'updating' as const }),
    commitParents: () => okAsync([]),
    baseChanges: () => okAsync({ commits: [], files: [] }),
    mergeQueueRequired: () => okAsync(false),
    enqueue: () => okAsync({ kind: 'queued' as const }),
    queueState: () => okAsync('merged' as const),
    pullHead: () => okAsync({ sha: 'sha-head', baseRef: 'main', autoMerge: false }),
    publishProofCheck: () => okAsync(undefined),
    ciState: () => {
      const next = states[Math.min(polls++, states.length - 1)]!;
      return 'message' in next ? errAsync(next) : okAsync(next);
    },
    merge: (_pr, options) => {
      merges.push(options);
      return okAsync(outcomes[Math.min(merges.length - 1, outcomes.length - 1)]!);
    },
  };
  return { prs, merges, polls: () => polls };
}

/** A fake clock that the fake sleep advances. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const actionsFor = (
  port: FactoryPullRequests,
  extra: { markMerged?: () => Promise<void> } = {},
) => {
  const c = clock();
  return createFactoryCiActions({ prs: port, pullRequest: () => pr, ...c, ...extra });
};

describe('wait_ci', () => {
  test('green after pending polls resolves ok', async () => {
    const { prs, polls } = scripted([{ kind: 'pending' }, { kind: 'pending' }, { kind: 'green' }]);
    const result = await actionsFor(prs).waitCi({ intervalMs: 1000 });
    expect(result).toMatchObject({ ok: true, output: 'green' });
    expect(polls()).toBe(3);
  });

  test('red resolves not ok with the failing checks, for the flow to fix', async () => {
    const checks = [{ name: 'test', conclusion: 'failure', excerpt: 'boom' }];
    const { prs } = scripted([{ kind: 'failing', checks }]);
    const result = await actionsFor(prs).waitCi();
    expect(result).toMatchObject({
      ok: false,
      error: 'Failing checks: test\n\n--- test ---\nboom',
      metadata: { verdict: 'red', failingChecks: checks },
    });
  });

  // openspec factory-flow-step-options, 5.3: enough for the fix step to reproduce it.
  test('red names the commit checked, each failed step and link, still starting with "Failing checks"', async () => {
    const checks = [
      {
        name: 'test',
        conclusion: 'failure',
        excerpt: 'boom',
        url: 'https://github.com/o/r/actions/runs/1/job/9',
        failedStep: 'Run tests',
      },
      { name: 'lint', conclusion: 'failure', excerpt: '' },
    ];
    const { prs } = scripted([{ kind: 'failing', checks, sha: 'abc123' }]);
    const result = await actionsFor(prs).waitCi();
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      [
        'Failing checks: test, lint',
        'Commit checked: abc123',
        '--- test ---\nFailed step: Run tests\nLink: https://github.com/o/r/actions/runs/1/job/9\nboom',
      ].join('\n\n'),
    );
  });

  test('the failure text stays bounded however long the logs are', async () => {
    const checks = Array.from({ length: 5 }, (_, i) => ({
      name: `check-${i}`,
      conclusion: 'failure',
      excerpt: 'x'.repeat(100_000),
      url: `https://example.test/${i}`,
    }));
    const { prs } = scripted([{ kind: 'failing', checks, sha: 'abc123' }]);
    const result = await actionsFor(prs).waitCi();
    expect(result.error!.length).toBeLessThan(5 * 10_000);
  });

  test('checks that could not run fail without the "Failing checks" the fix loop retries', async () => {
    const checks = [
      { name: '0security - PR Security', conclusion: 'error', excerpt: 'add a card' },
    ];
    const { prs } = scripted([{ kind: 'blocked', checks }]);
    const result = await actionsFor(prs).waitCi();
    expect(result).toMatchObject({
      ok: false,
      metadata: { verdict: 'blocked', blockedChecks: checks },
    });
    if (result.ok) throw new Error('expected a failure');
    expect(result.error).toContain('0security - PR Security (error: add a card)');
    expect(result.error).not.toContain('Failing checks');
  });

  test('a timeout is a terminal, non-green verdict instead of blocking the run', async () => {
    const { prs } = scripted([{ kind: 'pending' }]);
    const result = await actionsFor(prs).waitCi({ timeoutMs: 5000, intervalMs: 1000 });
    expect(result).toMatchObject({ ok: false, metadata: { verdict: 'timeout' } });
  });

  test('no checks is pending during the grace period, then counts as no CI', async () => {
    const early = scripted([{ kind: 'none' }, { kind: 'green' }]);
    expect(await actionsFor(early.prs).waitCi({ intervalMs: 1000 })).toMatchObject({
      ok: true,
      output: 'green',
    });

    const never = scripted([{ kind: 'none' }]);
    const result = await actionsFor(never.prs).waitCi({ intervalMs: NO_CHECKS_GRACE_MS / 4 });
    expect(result).toMatchObject({ ok: true, output: 'no-checks' });
  });

  test('missing App access surfaces the actionable error', async () => {
    const { prs } = scripted([
      { kind: 'not-installed', message: 'The GitHub App is not installed on o/r. Install it.' },
    ]);
    const result = await actionsFor(prs).waitCi();
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Install it'),
      metadata: { kind: 'not-installed' },
    });
  });

  test('required checks are asked for, and merge holds the PR to the same ones', async () => {
    const asked: unknown[] = [];
    const merged: unknown[] = [];
    const prs: FactoryPullRequests = {
      prState: () => okAsync('open'),
      changedFiles: () => okAsync({ files: [], truncated: false }),
      publishReview: () => okAsync({ status: true }),
      baseDistance: () => okAsync({ behindBy: 0, aheadBy: 1 }),
      updateBranch: () => okAsync({ kind: 'updating' as const }),
      commitParents: () => okAsync([]),
      baseChanges: () => okAsync({ commits: [], files: [] }),
      mergeQueueRequired: () => okAsync(false),
      enqueue: () => okAsync({ kind: 'queued' as const }),
      queueState: () => okAsync('merged' as const),
      pullHead: () => okAsync({ sha: 'sha-head', baseRef: 'main', autoMerge: false }),
      publishProofCheck: () => okAsync(undefined),
      ciState: (_pr, required) => {
        asked.push(required);
        return okAsync({ kind: 'green' });
      },
      merge: (_pr, options) => {
        merged.push(options?.requiredChecks);
        return okAsync({ kind: 'merged', method: 'squash', branchDeleted: false });
      },
    };
    const actions = actionsFor(prs);
    expect((await actions.waitCi({ requiredChecks: ['build'] })).ok).toBe(true);
    expect((await actions.merge()).ok).toBe(true);
    expect(asked).toEqual([['build']]);
    expect(merged).toEqual([['build']]);
  });

  test('stopping the run ends the wait', async () => {
    const controller = new AbortController();
    const { prs } = scripted([{ kind: 'pending' }]);
    const actions = createFactoryCiActions({
      prs,
      pullRequest: () => pr,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    expect(await actions.waitCi()).toMatchObject({ ok: false, error: 'The run was stopped.' });
  });
});

describe('merge', () => {
  test('a green PR is merged and the run is marked merged', async () => {
    let marked = false;
    const { prs, merges } = scripted([]);
    const result = await actionsFor(prs, {
      markMerged: async () => {
        marked = true;
      },
    }).merge({ method: 'squash', deleteBranch: true });
    expect(result).toMatchObject({ ok: true, output: 'merged' });
    expect(merges).toEqual([{ method: 'squash', deleteBranch: true }]);
    expect(marked).toBe(true);
  });

  test('a PR whose checks failed is not merged, the run is not marked, and nothing is waited for', async () => {
    let marked = false;
    const failing: CiState = { kind: 'failing', checks: [] };
    const { prs, merges, polls } = scripted([], { kind: 'not-green', ci: failing });
    const result = await actionsFor(prs, {
      markMerged: async () => {
        marked = true;
      },
    }).merge();
    expect(result).toMatchObject({ ok: false, metadata: { outcome: 'not-green' } });
    expect(marked).toBe(false);
    expect(merges).toHaveLength(1);
    expect(polls()).toBe(0);
  });

  test('checks still running are waited for, then the PR is merged', async () => {
    let marked = false;
    const { prs, merges, polls } = scripted(
      [{ kind: 'pending' }, { kind: 'green' }],
      [
        { kind: 'not-green', ci: { kind: 'pending' } },
        { kind: 'merged', method: 'squash', branchDeleted: false },
      ],
    );
    const result = await actionsFor(prs, {
      markMerged: async () => {
        marked = true;
      },
    }).merge();
    expect(result).toMatchObject({ ok: true, output: 'merged' });
    expect(merges).toHaveLength(2);
    expect(polls()).toBe(2);
    expect(marked).toBe(true);
  });

  test('checks that turn red while waited for end the merge with their failure', async () => {
    const failing: CiState = {
      kind: 'failing',
      checks: [{ name: 'security', conclusion: 'failure', excerpt: 'boom' }],
    };
    const { prs, merges } = scripted([{ kind: 'pending' }, failing], {
      kind: 'not-green',
      ci: { kind: 'pending' },
    });
    const result = await actionsFor(prs).merge();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Failing checks: security');
    expect(merges).toHaveLength(1);
  });

  test('checks that never finish are not merged once the wait runs out', async () => {
    let marked = false;
    const c = clock();
    const { prs } = scripted([{ kind: 'pending' }], {
      kind: 'not-green',
      ci: { kind: 'pending' },
    });
    const result = await createFactoryCiActions({
      prs,
      pullRequest: () => pr,
      ...c,
      markMerged: async () => {
        marked = true;
      },
    }).merge();
    expect(result).toMatchObject({ ok: false, metadata: { outcome: 'not-green', ci: 'pending' } });
    expect(result.error).toContain('still running');
    expect(c.now()).toBeLessThanOrEqual(MERGE_PENDING_TIMEOUT_MS);
    expect(marked).toBe(false);
  });

  test('without a pull request neither step acts', async () => {
    const { prs, merges, polls } = scripted([{ kind: 'green' }]);
    const actions = createFactoryCiActions({ prs, pullRequest: () => null });
    expect((await actions.waitCi()).ok).toBe(false);
    expect((await actions.merge()).ok).toBe(false);
    expect(polls()).toBe(0);
    expect(merges).toEqual([]);
  });
});
