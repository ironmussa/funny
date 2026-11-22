/**
 * The factory's server provider and the agent roles (change
 * factory-agent-roles): what the server checks on each commit of the run's
 * pull request by itself.
 */
import { describe, expect, test } from 'bun:test';

import type { PullRequestFile } from '@funny/core/github-app';
import type { FactoryRisk } from '@funny/shared/contracts/factory';
import { errAsync, ok, okAsync } from 'neverthrow';

import { createFactoryActionProvider } from '../../../services/factory/factory-action-provider.js';

type ProviderDeps = Parameters<typeof createFactoryActionProvider>[0];
type PullRequestsPort = ProviderDeps['github']['pullRequests'];

const PR = 'https://github.com/o/r/pull/12';

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

const changed = (path: string, lines: string[]): PullRequestFile => ({
  path,
  status: 'modified',
  additions: lines.filter((line) => line.startsWith('+')).length,
  deletions: lines.filter((line) => line.startsWith('-')).length,
  patch: ['@@ -1 +1 @@', ...lines].join('\n'),
});

function providerWith(pullRequests: Partial<PullRequestsPort>, over: Partial<ProviderDeps> = {}) {
  const risks: FactoryRisk[] = [];
  const provider = createFactoryActionProvider({
    scope,
    threadIds: ['t-impl'],
    prUrl: PR,
    launchStartedAt: null,
    findLaunched: async () => null,
    launch: async () => ok({ thread: { id: 't-new' }, threadId: 't-new', runnerId: 'r' }),
    waitThread: async () => ({ status: 'completed' as const, output: 'done' }),
    github: {
      branchAhead: () => okAsync(true),
      commentOnIssue: () => okAsync(undefined),
      findPullRequest: () => okAsync(null),
      pullRequests: {
        prState: () => okAsync('open' as const),
        changedFiles: () => okAsync({ files: [], truncated: false }),
        pullHead: () => okAsync({ sha: 'sha-1', baseRef: 'main', autoMerge: false }),
        publishProofCheck: () => okAsync(undefined),
        ciState: () => okAsync({ kind: 'green' as const }),
        merge: () =>
          okAsync({ kind: 'merged' as const, method: 'squash' as const, branchDeleted: false }),
        ...pullRequests,
      },
    },
    record: async (input) => {
      if (input.risk) risks.push(input.risk);
    },
    signal: new AbortController().signal,
    ...over,
  });
  return { provider, risks };
}

describe('risk class of the pull request head', () => {
  test('wait_ci classes the commit when its checks start and stores it on the run', async () => {
    const { provider, risks } = providerWith({
      changedFiles: () =>
        okAsync({ files: [changed('src/sum.ts', ['+return a + b;'])], truncated: false }),
    });
    await provider.waitCi({});
    expect(risks).toEqual([{ headSha: 'sha-1', level: 'low', reasons: [] }]);
  });

  test('a CI fix that skips a test makes the run high risk', async () => {
    const { provider, risks } = providerWith({
      changedFiles: () =>
        okAsync({
          files: [changed('src/sum.test.ts', ["+test.skip('adds', () => {});"])],
          truncated: false,
        }),
    });
    await provider.waitCi({});
    expect(risks).toEqual([
      {
        headSha: 'sha-1',
        level: 'high',
        reasons: ["skip-marker in src/sum.test.ts: test.skip('adds', () => {});"],
      },
    ]);
  });

  test('a commit is classed once; a new commit is classed again', async () => {
    let head = 'sha-1';
    let reads = 0;
    const { provider, risks } = providerWith({
      pullHead: () => okAsync({ sha: head, baseRef: 'main', autoMerge: false }),
      changedFiles: () => {
        reads += 1;
        return okAsync({ files: [], truncated: false });
      },
    });
    await provider.waitCi({});
    await provider.waitCi({});
    expect(reads).toBe(1);
    head = 'sha-2';
    await provider.waitCi({});
    expect(reads).toBe(2);
    expect(risks.map((risk) => risk.headSha)).toEqual(['sha-1', 'sha-2']);
  });

  test("the factory's sensitive paths count", async () => {
    const { provider, risks } = providerWith(
      {
        changedFiles: () =>
          okAsync({ files: [changed('billing/invoice.ts', ['+x'])], truncated: false }),
      },
      { sensitivePaths: ['billing/**'] },
    );
    await provider.waitCi({});
    expect(risks[0]).toMatchObject({ level: 'high' });
  });

  test('a change that cannot be read is high risk, and the checks are still waited on', async () => {
    const { provider, risks } = providerWith({
      changedFiles: () =>
        errAsync({ kind: 'github-error' as const, message: 'GitHub answered 502' }),
    });
    expect(await provider.waitCi({})).toMatchObject({ ok: true });
    expect(risks).toEqual([
      {
        headSha: 'sha-1',
        level: 'high',
        reasons: ['the change could not be read: GitHub answered 502'],
      },
    ]);
  });
});
