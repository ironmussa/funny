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
  NO_CHECKS_GRACE_MS,
} from '../../../services/factory/factory-ci-actions.js';
import type {
  FactoryMergeOutcome,
  FactoryPullRequestError,
  FactoryPullRequests,
} from '../../../services/factory/factory-pull-requests.js';

const pr = { repo: 'o/r', number: 7, userId: 'alice', projectId: 'p1' };

/** A port that answers `ciState` from a script (last answer repeats) and `merge` with `outcome`. */
function scripted(
  states: Array<CiState | FactoryPullRequestError>,
  outcome: FactoryMergeOutcome = { kind: 'merged', method: 'squash', branchDeleted: false },
) {
  let polls = 0;
  const merges: unknown[] = [];
  const prs: FactoryPullRequests = {
    prState: () => okAsync('open'),
    changedFiles: () => okAsync({ files: [], truncated: false }),
    pullHead: () => okAsync({ sha: 'sha-head', baseRef: 'main', autoMerge: false }),
    publishProofCheck: () => okAsync(undefined),
    ciState: () => {
      const next = states[Math.min(polls++, states.length - 1)]!;
      return 'message' in next ? errAsync(next) : okAsync(next);
    },
    merge: (_pr, options) => {
      merges.push(options);
      return okAsync(outcome);
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

  test('a PR that is not green is not merged and the run is not marked', async () => {
    let marked = false;
    const { prs } = scripted([], { kind: 'not-green', ci: { kind: 'pending' } });
    const result = await actionsFor(prs, {
      markMerged: async () => {
        marked = true;
      },
    }).merge();
    expect(result).toMatchObject({ ok: false, metadata: { outcome: 'not-green' } });
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
