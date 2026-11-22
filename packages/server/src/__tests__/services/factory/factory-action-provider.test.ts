/**
 * The factory's server provider on its own: replaying steps that continued the
 * same thread, and a thread whose launch raced a stop.
 */
import { describe, expect, test } from 'bun:test';

import type { GithubCallError } from '@funny/core/github-app';
import { EMPTY_FACTORY_RUN_METRICS } from '@funny/shared/contracts/factory';
import { err, errAsync, ok, okAsync, type ResultAsync } from 'neverthrow';

import {
  countCiResult,
  createFactoryActionProvider,
  NO_CHANGE_LINE,
} from '../../../services/factory/factory-action-provider.js';
import type {
  FactoryMergeOptions,
  FactoryMergeOutcome,
} from '../../../services/factory/factory-pull-requests.js';

const scope = {
  runId: 'r1',
  userId: 'alice',
  projectId: 'p1',
  repo: 'o/r',
  mode: 'local' as const,
  issueNumber: 7,
  issueTitle: 'Fix it',
  branch: 'factory/issue-7-r1',
};

function providerWith(over: Partial<Parameters<typeof createFactoryActionProvider>[0]> = {}) {
  const waited: string[] = [];
  const deps = {
    scope,
    threadIds: new Array<string>(),
    prUrl: null,
    launchStartedAt: null,
    findLaunched: async () => null,
    launch: async () => ok({ thread: { id: 't-new' }, threadId: 't-new', runnerId: 'r' }),
    waitThread: async (threadId: string) => {
      waited.push(threadId);
      return { status: 'completed' as const, output: 'done' };
    },
    github: {
      branchAhead: () => okAsync(true),
      commentOnIssue: () => okAsync(undefined),
      findPullRequest: () => okAsync(null),
      pullRequests: {
        prState: () => okAsync('open' as const),
        headSha: () => okAsync('sha-head'),
        ciState: () => okAsync({ kind: 'green' as const }),
        merge: () =>
          okAsync({ kind: 'merged' as const, method: 'squash' as const, branchDeleted: false }),
      },
    },
    record: async () => undefined,
    signal: new AbortController().signal,
    ...over,
  };
  return { provider: createFactoryActionProvider(deps), waited };
}

describe('factory action provider', () => {
  test('a replayed step that a later step continued on the same thread does not wait on it', async () => {
    const { provider, waited } = providerWith({ threadIds: ['A', 'A'] });
    // The implement step: the fix (step 2) already ran on A after it.
    expect(await provider.spawnAgent({ prompt: 'implement', cwd: '' })).toMatchObject({ ok: true });
    expect(waited).toEqual([]);
    // The last recorded step is the one still waited on.
    expect(await provider.spawnAgent({ prompt: 'fix', cwd: '' })).toMatchObject({ ok: true });
    expect(waited).toEqual(['A']);
  });

  test("a new thread is launched on the run's branch, so its worktree and the PR share one", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { provider } = providerWith({
      launch: async (body) => {
        bodies.push(body);
        return ok({ thread: { id: 't-new' }, threadId: 't-new', runnerId: 'r' });
      },
    });
    await provider.spawnAgent({ prompt: 'implement', cwd: '' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ branch: 'factory/issue-7-r1', source: 'factory' });
  });

  test('a thread whose launch finished after the run was stopped is stopped', async () => {
    const controller = new AbortController();
    const abandoned: string[] = [];
    const { provider } = providerWith({
      signal: controller.signal,
      launch: async () => {
        controller.abort(); // the member clicked Stop while the runner was creating it
        return ok({ thread: { id: 't-late' }, threadId: 't-late', runnerId: 'r' });
      },
      waitThread: async () => ({ status: 'cancelled' as const }),
      abandon: async (threadId) => {
        abandoned.push(threadId);
      },
    });
    await provider.spawnAgent({ prompt: 'implement', cwd: '' });
    expect(abandoned).toEqual(['t-late']);
  });

  test('an interrupted launch is adopted by the stable title prefix, not the full title', async () => {
    const prefixes: string[] = [];
    let launches = 0;
    const { provider } = providerWith({
      launchStartedAt: new Date().toISOString(),
      findLaunched: async (prefix) => {
        prefixes.push(prefix);
        return 't-orphan';
      },
      launch: async () => {
        launches++;
        return ok({ thread: {}, threadId: 't-new', runnerId: 'r' });
      },
    });
    await provider.spawnAgent({ prompt: 'implement', cwd: '' });
    expect(prefixes).toEqual(['[Factory] #7 ']);
    expect(launches).toBe(0);
  });
});

describe('factory action provider integration metrics', () => {
  const PR = 'https://github.com/o/r/pull/5';
  const failing = {
    kind: 'failing' as const,
    checks: [{ name: 'test', excerpt: 'boom' }],
  } as never;

  test('counts each CI verdict as a round and a red one as red, and stores the counters', async () => {
    const recorded: unknown[] = [];
    const looks = [failing, { kind: 'green' as const }];
    const { provider } = providerWith({
      prUrl: PR,
      github: {
        branchAhead: () => okAsync(true),
        commentOnIssue: () => okAsync(undefined),
        findPullRequest: () => okAsync(null),
        pullRequests: {
          prState: () => okAsync('open' as const),
          headSha: () => okAsync('sha-head'),
          ciState: () => okAsync(looks.shift()!),
          merge: () =>
            okAsync({ kind: 'merged' as const, method: 'squash' as const, branchDeleted: false }),
        },
      },
      record: async (input) => {
        if (input.metrics) recorded.push(input.metrics);
      },
    });
    expect(await provider.waitCi({})).toMatchObject({ ok: false });
    expect(await provider.waitCi({})).toMatchObject({ ok: true });
    expect(recorded.at(-1)).toMatchObject({ ciRounds: 2, ciRed: 1, conflicts: 0 });
  });

  test('a resumed run keeps counting from its stored counters', async () => {
    const recorded: unknown[] = [];
    const { provider } = providerWith({
      prUrl: PR,
      metrics: {
        ciRounds: 2,
        ciRed: 1,
        conflicts: 0,
        ciBlocked: 0,
        ciTimeouts: 0,
        agentFixes: 1,
      },
      record: async (input) => {
        if (input.metrics) recorded.push(input.metrics);
      },
    });
    await provider.waitCi({});
    expect(recorded.at(-1)).toMatchObject({ ciRounds: 3, ciRed: 1, agentFixes: 1 });
  });

  test('a follow-up once the pull request is open counts as an agent fix', async () => {
    const recorded: unknown[] = [];
    const { provider } = providerWith({
      threadIds: ['A'],
      prUrl: PR,
      continuation: {
        followUp: async () => ok(undefined),
        completedAt: async () => null,
        followedUpSince: async () => false,
      },
      record: async (input) => {
        if (input.metrics) recorded.push(input.metrics);
      },
    });
    await provider.spawnAgent({ prompt: 'implement', cwd: '' });
    await provider.spawnAgent({ prompt: 'fix the checks', cwd: '' });
    expect(recorded.at(-1)).toMatchObject({ agentFixes: 1, ciRounds: 0 });
  });

  test('a stop or an access error is not a CI round', () => {
    const base = { ...EMPTY_FACTORY_RUN_METRICS };
    expect(countCiResult(base, { ok: false, error: 'The run was stopped.' })).toBeNull();
    expect(
      countCiResult(base, { ok: false, error: 'no access', metadata: { kind: 'auth' } }),
    ).toBeNull();
    expect(
      countCiResult(base, { ok: false, error: 'x', metadata: { verdict: 'conflict' } }),
    ).toMatchObject({ ciRounds: 1, conflicts: 1 });
  });
});

describe('factory action provider regression proof', () => {
  const rules = [{ globs: ['**/*.test.ts'], command: 'bun test {{files}}' }];
  const done = (verdict: string) =>
    ok({ state: 'done', result: { verdict, headSha: 'sha-head', files: [] } });

  test('the runner resolves the commit: the server sends no headSha or defaultBranch', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const recorded: unknown[] = [];
    const { provider } = providerWith({
      threadIds: ['t1'],
      proof: {
        startProof: async (_threadId, body) => {
          bodies.push(body);
          return ok({ proofId: 'p1', state: 'running' });
        },
        pollProof: async () => done('pass'),
      },
      record: async (input) => {
        if (input.regressionProof) recorded.push(input.regressionProof);
      },
    });
    const result = await provider.regressionProof!({ rules });
    expect(result.ok).toBe(true);
    expect(bodies[0]).not.toHaveProperty('headSha');
    expect(bodies[0]).not.toHaveProperty('defaultBranch');
    expect(recorded[0]).toMatchObject({ headSha: 'sha-head', verdict: 'pass' });
  });

  test('after a lost job is restarted, polling follows the new proof id', async () => {
    const polled: string[] = [];
    let starts = 0;
    const { provider } = providerWith({
      threadIds: ['t1'],
      proof: {
        startProof: async () => ok({ proofId: `p${++starts}`, state: 'running' }),
        pollProof: async (_threadId, proofId) => {
          polled.push(proofId);
          return proofId === 'p1' ? err('proof-not-found') : done('pass');
        },
      },
    });
    const result = await provider.regressionProof!({ rules });
    expect(result.ok).toBe(true);
    expect(polled).toEqual(['p1', 'p2']);
  });

  test('an issue with a required label fails a proof that found no test', async () => {
    const proof = {
      startProof: async () => ok({ proofId: 'p1', state: 'running' }),
      pollProof: async () => done('skipped'),
    };
    const opts = { rules, requireTest: 'labels' as const, labels: ['bug'] };
    const bug = providerWith({ threadIds: ['t1'], proof, issueLabels: ['bug'] });
    expect((await bug.provider.regressionProof!(opts)).ok).toBe(false);
    const other = providerWith({ threadIds: ['t1'], proof, issueLabels: ['enhancement'] });
    expect((await other.provider.regressionProof!(opts)).ok).toBe(true);
  });
});

describe('factory action provider merge gate', () => {
  const rules = [{ globs: ['**/*.test.ts'], command: 'bun test {{files}}' }];
  const proofConfig = { rules };

  /** A provider with an open PR whose head is `head`, and a runner proving `proves`. */
  function gated(opts: {
    head?: string;
    proves?: string;
    verdict?: string;
    outcome?: FactoryMergeOutcome;
  }) {
    const merges: Array<FactoryMergeOptions | undefined> = [];
    let proofs = 0;
    const { provider } = providerWith({
      threadIds: ['t1'],
      prUrl: 'https://github.com/o/r/pull/9',
      proof: {
        startProof: async () => ok({ proofId: `p${++proofs}`, state: 'running' }),
        pollProof: async () =>
          ok({
            state: 'done',
            result: { verdict: opts.verdict ?? 'pass', headSha: opts.proves ?? 'sha-head' },
          }),
      },
      github: {
        branchAhead: () => okAsync(true),
        commentOnIssue: () => okAsync(undefined),
        findPullRequest: () => okAsync(null),
        pullRequests: {
          prState: () => okAsync('open' as const),
          headSha: () => okAsync(opts.head ?? 'sha-head'),
          ciState: () => okAsync({ kind: 'green' as const }),
          merge: (_pr: unknown, options?: FactoryMergeOptions) => {
            merges.push(options);
            return okAsync(
              opts.outcome ?? {
                kind: 'merged' as const,
                method: 'squash' as const,
                branchDeleted: false,
              },
            );
          },
        },
      },
    });
    return { provider, merges, proofs: () => proofs };
  }

  test('a passing proof of the head merges that exact commit, without proving again', async () => {
    const { provider, merges, proofs } = gated({});
    expect((await provider.regressionProof!(proofConfig)).ok).toBe(true);
    const merged = await provider.merge({ regressionProof: proofConfig });
    expect(merged.ok).toBe(true);
    expect(proofs()).toBe(1);
    expect(merges[0]).toMatchObject({ sha: 'sha-head' });
  });

  test('a proof of an older commit is run again for the head before the merge', async () => {
    const { provider, merges, proofs } = gated({});
    await provider.regressionProof!(proofConfig);
    // The PR head moved after the proof step: the gate proves the new head.
    const later = gated({ head: 'sha-new', proves: 'sha-new' });
    expect((await later.provider.merge({ regressionProof: proofConfig })).ok).toBe(true);
    expect(later.proofs()).toBe(1);
    expect(later.merges[0]).toMatchObject({ sha: 'sha-new' });
    expect(proofs()).toBe(1);
    expect(merges).toHaveLength(0);
  });

  test('a failing proof does not merge', async () => {
    const { provider, merges } = gated({ verdict: 'fail' });
    const merged = await provider.merge({ regressionProof: proofConfig });
    expect(merged.ok).toBe(false);
    expect(merged.error).toContain('Regression proof');
    expect(merges).toHaveLength(0);
  });

  test('a flow without a configured proof does not merge', async () => {
    const { provider, merges } = gated({});
    const noStep = await provider.merge({});
    expect(noStep.error).toContain('no regression proof configured');
    const noRules = await provider.merge({ regressionProof: { rules: [] } });
    expect(noRules.ok).toBe(false);
    expect(merges).toHaveLength(0);
  });

  test('the opt-out merges as before, unpinned', async () => {
    const { provider, merges } = gated({});
    expect((await provider.merge({ requireRegressionProof: false })).ok).toBe(true);
    expect(merges[0]?.sha).toBeUndefined();
  });

  test('a head that is not the proved commit is not merged', async () => {
    const { provider, merges } = gated({ head: 'sha-pr', proves: 'sha-local' });
    const merged = await provider.merge({ regressionProof: proofConfig });
    expect(merged.ok).toBe(false);
    expect(merged.error).toContain('not the proved commit');
    expect(merges).toHaveLength(0);
  });

  test('GitHub refusing the direct merge leaves the run unmerged', async () => {
    const { provider } = gated({
      outcome: { kind: 'not-mergeable', reason: 'head moved' },
    });
    const merged = await provider.merge({ regressionProof: proofConfig });
    expect(merged.ok).toBe(false);
    expect(merged.error).toContain('head moved');
  });
});

describe('factory action provider "no change" outcome', () => {
  function noPr(branchAhead: ResultAsync<boolean, GithubCallError>) {
    const comments: string[] = [];
    const records: Array<Record<string, unknown>> = [];
    let removed = 0;
    const { provider } = providerWith({
      threadIds: ['t1'],
      lastThreadMessage: async () => 'The bug is already fixed on main.',
      removeWorktrees: async () => {
        removed++;
      },
      github: {
        findPullRequest: () => okAsync(null),
        branchAhead: () => branchAhead,
        commentOnIssue: (_reader: unknown, _issue: number, body: string) => {
          comments.push(body);
          return okAsync(undefined);
        },
        pullRequests: {
          prState: () => okAsync('open' as const),
          headSha: () => okAsync('sha-head'),
          ciState: () => okAsync({ kind: 'green' as const }),
          merge: () =>
            okAsync({ kind: 'merged' as const, method: 'squash' as const, branchDeleted: false }),
        },
      },
      record: async (input) => {
        records.push({ ...input });
      },
    });
    return { provider, comments, records, removed: () => removed };
  }

  test('no pull request and no commits: comment, clean up, wait for a person, stop the flow', async () => {
    const { provider, comments, records, removed } = noPr(okAsync<boolean, GithubCallError>(false));
    const result = await provider.createPr({ cwd: '', title: 'Fix it' });
    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({ outcome: 'no_change' });
    expect(comments).toEqual([`${NO_CHANGE_LINE}\n\nThe bug is already fixed on main.`]);
    expect(removed()).toBe(1);
    expect(records).toContainEqual({ state: 'waiting_human', failureReason: 'no change' });
  });

  test('no pull request but commits ahead: the agent did not open one (an error, no comment)', async () => {
    const { provider, comments, records } = noPr(okAsync<boolean, GithubCallError>(true));
    const result = await provider.createPr({ cwd: '', title: 'Fix it' });
    expect(result.error).toContain('No open pull request');
    expect(comments).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  test('an unreadable branch is not taken for "no change"', async () => {
    const { provider, comments } = noPr(
      errAsync<boolean, GithubCallError>({ message: 'GitHub answered 500', status: 500 }),
    );
    const result = await provider.createPr({ cwd: '', title: 'Fix it' });
    expect(result.error).toContain('No open pull request');
    expect(comments).toHaveLength(0);
  });
});
