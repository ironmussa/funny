/**
 * The factory's server provider and the agent roles (change
 * factory-agent-roles): what the server checks on each commit of the run's
 * pull request by itself.
 */
import { describe, expect, test } from 'bun:test';

import type { PullRequestFile } from '@funny/core/github-app';
import type { FactoryRisk } from '@funny/shared/contracts/factory';
import { err, errAsync, ok, okAsync } from 'neverthrow';

import { createFactoryActionProvider } from '../../../services/factory/factory-action-provider.js';
import {
  NO_VERDICT_REASON,
  REVIEWER_DISALLOWED_TOOLS,
} from '../../../services/factory/factory-review.js';
import type { UpdateRunInput } from '../../../services/factory/factory-runs.js';

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
  issueUrl: 'https://github.com/o/r/issues/7',
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

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const json = (value: unknown) => ['```json', JSON.stringify(value), '```'].join('\n');
const passOf = (sha: string) => json({ sha, verdict: 'pass', summary: 'Looks right.' });
const failOf = (sha: string, severity = 'high') =>
  json({
    sha,
    verdict: 'fail',
    findings: [{ severity, title: 'Negative numbers are dropped', path: 'src/sum.ts', line: 3 }],
  });

interface ReviewScript {
  /** The pull request's head commit, read on each look. */
  head?: () => string;
  /** What each reviewer thread says, by launch order: its final message, then after each follow-up. */
  says: string[][];
  /** How each reviewer thread ends (default completed). */
  ends?: Array<'completed' | 'failed' | 'stopped'>;
  /** A review thread already launched for the head (found by its title). */
  launched?: string;
  /** How that thread ended (default completed). */
  launchedEnds?: 'completed' | 'stopped';
  reviews?: ProviderDeps['reviews'];
  files?: PullRequestFile[];
  followUpFails?: boolean;
}

/** A provider whose reviewer threads answer from a script; records what the server did. */
function reviewing(script: ReviewScript) {
  const bodies: Record<string, unknown>[] = [];
  const followUps: Array<{ threadId: string; content: string }> = [];
  const recorded: UpdateRunInput[] = [];
  const stages: string[] = [];
  const abandoned: string[] = [];
  const turn = new Map<string, number>();
  const indexOf = (threadId: string) =>
    threadId === script.launched ? 0 : Number(threadId.replace('rev-', '')) - 1;
  const { provider } = providerWith(
    {
      pullHead: () => okAsync({ sha: script.head?.() ?? SHA_A, baseRef: 'main', autoMerge: false }),
      changedFiles: () => okAsync({ files: script.files ?? [], truncated: false }),
    },
    {
      reviews: script.reviews,
      admittedAt: '2026-11-22T00:00:00.000Z',
      launch: async (body) => {
        bodies.push(body);
        const threadId = `rev-${bodies.length}`;
        return ok({ thread: { id: threadId }, threadId, runnerId: 'r' });
      },
      findReviewThread: async () => script.launched ?? null,
      waitThread: async (threadId) => {
        const status =
          threadId === script.launched
            ? (script.launchedEnds ?? 'completed')
            : (script.ends?.[indexOf(threadId)] ?? 'completed');
        return status === 'completed' ? { status, output: '' } : { status };
      },
      lastThreadMessage: async (threadId) => {
        // The implementing agent's thread: never read for a review.
        if (threadId === 't-impl') return 'IMPLEMENTER-PRIVATE-NOTES';
        return script.says[indexOf(threadId)]?.[turn.get(threadId) ?? 0] ?? null;
      },
      continuation: {
        followUp: async () => ok(undefined),
        completedAt: async () => '2026-11-22T01:00:00.000Z',
        followedUpSince: async () => false,
        followUpOffBranch: async (threadId, content) => {
          if (script.followUpFails) return err('the runner is offline');
          followUps.push({ threadId, content });
          turn.set(threadId, (turn.get(threadId) ?? 0) + 1);
          return ok(undefined);
        },
      },
      abandon: async (threadId) => {
        abandoned.push(threadId);
      },
      enterStage: async (stage) => {
        stages.push(stage);
      },
      record: async (input) => {
        recorded.push(input);
      },
    },
  );
  const stored = () => {
    const writes = recorded.flatMap((input) => (input.reviews ? [input.reviews] : []));
    return writes.at(-1) ?? [];
  };
  return { provider, bodies, followUps, recorded, stages, abandoned, stored };
}

describe('the review step', () => {
  test("runs on a new read-only thread that is not the implementing agent's", async () => {
    const { provider, bodies, stages } = reviewing({ says: [[passOf(SHA_A)]] });
    await provider.review!({});
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      projectId: 'p1',
      source: 'factory',
      permissionMode: 'plan',
      disallowedTools: [...REVIEWER_DISALLOWED_TOOLS],
      title: `[Factory review] #7 ${SHA_A.slice(0, 8)} Fix it`,
    });
    // Its own thread, not a checkout of the run's branch.
    expect(bodies[0]).not.toHaveProperty('branch');
    expect(REVIEWER_DISALLOWED_TOOLS).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']),
    );
    expect(stages).toEqual(['review']);
  });

  test('the prompt has the commit, the pull request and the issue, and nothing the implementer said', async () => {
    const { provider, bodies } = reviewing({
      says: [[passOf(SHA_A)]],
      files: [changed('src/sum.test.ts', ["+test.skip('adds', () => {});"])],
    });
    await provider.review!({});
    const prompt = String(bodies[0]?.prompt);
    expect(prompt).toContain(SHA_A);
    expect(prompt).toContain(PR);
    // A run without a contract is judged against the issue, read from its URL.
    expect(prompt).toContain('https://github.com/o/r/issues/7');
    expect(prompt).toContain('skip-marker in src/sum.test.ts');
    expect(prompt).toContain('Risk class: high');
    expect(prompt).not.toContain('IMPLEMENTER-PRIVATE-NOTES');
    expect(prompt).not.toContain('Fix it\n');
  });

  test("the flow's provider, model and effort reach the reviewer", async () => {
    const { provider, bodies } = reviewing({ says: [[passOf(SHA_A)]] });
    await provider.review!({ provider: 'codex', model: 'gpt-5', effort: 'high' });
    expect(bodies[0]).toMatchObject({ provider: 'codex', model: 'gpt-5', effort: 'high' });
  });

  test('a pass is stored for its commit and lets the change go on', async () => {
    const { provider, stored } = reviewing({ says: [[`All good.\n${passOf(SHA_A)}`]] });
    const result = await provider.review!({});
    expect(result).toMatchObject({
      ok: true,
      output: 'pass',
      metadata: { verdict: 'pass', allowsMerge: true, sha: SHA_A, threadId: 'rev-1' },
    });
    expect(stored()).toMatchObject([{ sha: SHA_A, verdict: 'pass', threadId: 'rev-1' }]);
  });

  test('a fail with a high finding does not, and its findings are the feedback', async () => {
    const { provider, stored } = reviewing({ says: [[failOf(SHA_A)]] });
    const result = await provider.review!({});
    expect(result).toMatchObject({ ok: true, output: 'fail', metadata: { allowsMerge: false } });
    expect(String(result.metadata?.feedback)).toContain(
      '- [high] src/sum.ts:3: Negative numbers are dropped',
    );
    expect(stored()).toMatchObject([{ sha: SHA_A, verdict: 'fail' }]);
  });

  test('a fail with only lower findings counts as a pass with comments', async () => {
    const { provider } = reviewing({ says: [[failOf(SHA_A, 'medium')]] });
    expect(await provider.review!({})).toMatchObject({
      ok: true,
      output: 'pass',
      metadata: { verdict: 'fail', allowsMerge: true },
    });
  });

  test('prose instead of a result: asked once on the review thread, then read', async () => {
    const { provider, followUps } = reviewing({ says: [['It looks fine to me.', passOf(SHA_A)]] });
    expect(await provider.review!({})).toMatchObject({ ok: true, output: 'pass' });
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.threadId).toBe('rev-1');
  });

  test('a result for another commit is invalid', async () => {
    const { provider, followUps, stored } = reviewing({
      says: [[passOf(SHA_B), passOf(SHA_B)]],
    });
    const result = await provider.review!({});
    expect(result.ok).toBe(false);
    expect(followUps[0]?.content).toContain(SHA_A);
    expect(stored()).toEqual([]);
  });

  test('no valid result twice: the run waits for a person and nothing is stored', async () => {
    const { provider, recorded, followUps, stored } = reviewing({
      says: [['prose', 'more prose']],
    });
    const result = await provider.review!({});
    expect(result).toMatchObject({ ok: false, metadata: { outcome: 'no_verdict' } });
    expect(result.error).toContain('The review gave no verdict');
    expect(followUps).toHaveLength(1);
    expect(recorded).toContainEqual({ state: 'waiting_human', failureReason: NO_VERDICT_REASON });
    expect(stored()).toEqual([]);
  });

  test('a reviewer that cannot be asked again fails closed too', async () => {
    const { provider, recorded } = reviewing({ says: [['prose']], followUpFails: true });
    expect((await provider.review!({})).ok).toBe(false);
    expect(recorded).toContainEqual({ state: 'waiting_human', failureReason: NO_VERDICT_REASON });
  });

  test('a reviewer thread that fails is a failed step, not a verdict', async () => {
    const { provider, stored } = reviewing({ says: [[passOf(SHA_A)]], ends: ['failed'] });
    const result = await provider.review!({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not finish');
    expect(stored()).toEqual([]);
  });

  test('a commit that already has a verdict is not reviewed again', async () => {
    const { provider, bodies } = reviewing({
      says: [],
      reviews: [
        { sha: SHA_A, verdict: 'pass', findings: [], reviewedAt: '2026-11-22T02:00:00.000Z' },
      ],
    });
    expect(await provider.review!({})).toMatchObject({ ok: true, output: 'pass' });
    expect(bodies).toEqual([]);
  });

  test('a push after a pass: the new commit gets its own review on a new thread', async () => {
    let head = SHA_A;
    const { provider, bodies, stored } = reviewing({
      head: () => head,
      says: [[passOf(SHA_A)], [failOf(SHA_B)]],
    });
    expect(await provider.review!({})).toMatchObject({ output: 'pass' });
    head = SHA_B;
    expect(await provider.review!({})).toMatchObject({ output: 'fail', metadata: { sha: SHA_B } });
    expect(bodies).toHaveLength(2);
    expect(stored().map((review) => [review.sha, review.verdict])).toEqual([
      [SHA_A, 'pass'],
      [SHA_B, 'fail'],
    ]);
  });

  test('a resumed run adopts the review thread it already launched for the commit', async () => {
    const { provider, bodies, stored } = reviewing({
      says: [[passOf(SHA_A)]],
      launched: 'rev-old',
    });
    expect(await provider.review!({})).toMatchObject({ ok: true, output: 'pass' });
    expect(bodies).toEqual([]);
    expect(stored()).toMatchObject([{ threadId: 'rev-old' }]);
  });

  test('an adopted review thread that was stopped is replaced by a new review', async () => {
    const { provider, bodies, stored } = reviewing({
      says: [[passOf(SHA_A)]],
      launched: 'rev-old',
      launchedEnds: 'stopped',
    });
    expect(await provider.review!({})).toMatchObject({ ok: true, output: 'pass' });
    expect(bodies).toHaveLength(1);
    expect(stored()).toMatchObject([{ threadId: 'rev-1' }]);
  });
});
