/**
 * The factory's server provider and the agent roles (change
 * factory-agent-roles): what the server checks on each commit of the run's
 * pull request by itself.
 */
import { describe, expect, test } from 'bun:test';

import type { PullRequestFile } from '@funny/core/github-app';
import type { CiState } from '@funny/core/github-app';
import type { FactoryRisk } from '@funny/shared/contracts/factory';
import { err, errAsync, ok, okAsync } from 'neverthrow';

import { createFactoryActionProvider } from '../../../services/factory/factory-action-provider.js';
import { MERGE_HOLD_REASONS } from '../../../services/factory/factory-action-provider.js';
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
        publishReview: () => okAsync({ status: true }),
        baseDistance: () => okAsync({ behindBy: 0, aheadBy: 1 }),
        updateBranch: () => okAsync({ kind: 'updating' as const }),
        commitParents: () => okAsync([]),
        baseChanges: () => okAsync({ commits: [], files: [] }),
        mergeQueueRequired: () => okAsync(false),
        enqueue: () => okAsync({ kind: 'queued' as const }),
        queueState: () => okAsync('merged' as const),
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
  /** How putting the verdict on the pull request goes (default: comment and status). */
  publishes?: 'comment-only' | 'fails';
  /** A reviewer thread finishes only once this settles (default: at once). */
  gate?: (threadId: string) => Promise<void>;
  /** The factory's review slot: granted once this settles (default: reviews are not limited). */
  slot?: (holder: string) => Promise<() => void>;
  /** What triage stored on the run (its contract). */
  triage?: ProviderDeps['triage'];
}

/** A provider whose reviewer threads answer from a script; records what the server did. */
function reviewing(script: ReviewScript) {
  const bodies: Record<string, unknown>[] = [];
  const followUps: Array<{ threadId: string; content: string }> = [];
  const recorded: UpdateRunInput[] = [];
  const stages: string[] = [];
  const abandoned: string[] = [];
  const published: Array<{ sha: string; allowsMerge: boolean; body: string; description: string }> =
    [];
  const turn = new Map<string, number>();
  const indexOf = (threadId: string) =>
    threadId === script.launched ? 0 : Number(threadId.replace('rev-', '')) - 1;
  const { provider } = providerWith(
    {
      pullHead: () => okAsync({ sha: script.head?.() ?? SHA_A, baseRef: 'main', autoMerge: false }),
      changedFiles: () => okAsync({ files: script.files ?? [], truncated: false }),
      publishReview: (_pr, review) => {
        published.push(review);
        return script.publishes === 'fails'
          ? errAsync({ kind: 'github-error' as const, message: 'GitHub answered 502' })
          : okAsync({ status: script.publishes !== 'comment-only' });
      },
    },
    {
      reviews: script.reviews,
      triage: script.triage,
      admittedAt: '2026-11-22T00:00:00.000Z',
      launch: async (body) => {
        bodies.push(body);
        const threadId = `rev-${bodies.length}`;
        return ok({ thread: { id: threadId }, threadId, runnerId: 'r' });
      },
      findReviewThread: async () => script.launched ?? null,
      reviewSlot: script.slot ? (holder) => script.slot!(holder) : undefined,
      waitThread: async (threadId) => {
        await script.gate?.(threadId);
        // A stopped thread ends stopped, whatever it would have said.
        if (abandoned.includes(threadId)) return { status: 'stopped' as const };
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
  return { provider, bodies, followUps, recorded, stages, abandoned, stored, published };
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

describe('the review starts with the checks', () => {
  /** A gate the test opens per thread: a reviewer still working until then. */
  function gates() {
    const open = new Map<string, () => void>();
    const waiting = new Map<string, Promise<void>>();
    const gate = (threadId: string) => {
      if (!waiting.has(threadId)) {
        waiting.set(threadId, new Promise<void>((resolve) => open.set(threadId, resolve)));
      }
      return waiting.get(threadId)!;
    };
    return { gate, finish: (threadId: string) => open.get(threadId)?.() };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  test('wait_ci starts the review of the commit; the review step does not start another', async () => {
    const { provider, bodies, stored } = reviewing({ says: [[passOf(SHA_A)]] });
    await provider.waitCi({ earlyReview: {} });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ title: `[Factory review] #7 ${SHA_A.slice(0, 8)} Fix it` });
    // The review finished while the checks ran: its verdict is waiting for the step.
    await settle();
    expect(stored()).toMatchObject([{ sha: SHA_A, verdict: 'pass' }]);
    expect(await provider.review!({})).toMatchObject({ ok: true, output: 'pass' });
    expect(bodies).toHaveLength(1);
  });

  test('the checks finish first: the review step waits for the review in flight', async () => {
    const { gate, finish } = gates();
    const { provider, bodies, stored } = reviewing({ says: [[passOf(SHA_A)]], gate });
    expect(await provider.waitCi({ earlyReview: {} })).toMatchObject({ ok: true });
    expect(stored()).toEqual([]);
    const step = provider.review!({});
    await settle();
    finish('rev-1');
    expect(await step).toMatchObject({ ok: true, output: 'pass' });
    expect(bodies).toHaveLength(1);
  });

  test('a CI fix replaces the commit under review: its review is stopped and never stored', async () => {
    let head = SHA_A;
    const { gate, finish } = gates();
    const { provider, bodies, abandoned, stored } = reviewing({
      head: () => head,
      says: [[passOf(SHA_A)], [passOf(SHA_B)]],
      gate,
    });
    await provider.waitCi({ earlyReview: {} });
    head = SHA_B;
    await provider.waitCi({ earlyReview: {} });
    expect(abandoned).toEqual(['rev-1']);
    expect(bodies).toHaveLength(2);
    // The stopped reviewer ends; nothing of commit A is kept.
    finish('rev-1');
    finish('rev-2');
    await settle();
    expect(stored().map((review) => review.sha)).toEqual([SHA_B]);
    expect(await provider.review!({})).toMatchObject({ output: 'pass', metadata: { sha: SHA_B } });
  });

  test('a flow that turns it off: nothing starts before the review step', async () => {
    const { provider, bodies } = reviewing({ says: [[passOf(SHA_A)]] });
    // `early: false`: the compiler passes no review configuration to wait_ci.
    await provider.waitCi({});
    expect(bodies).toEqual([]);
    await provider.review!({ early: false });
    expect(bodies).toHaveLength(1);
  });

  test('a commit that already has a verdict is not reviewed again when its checks rerun', async () => {
    const { provider, bodies } = reviewing({
      says: [],
      reviews: [
        { sha: SHA_A, verdict: 'pass', findings: [], reviewedAt: '2026-11-22T02:00:00.000Z' },
      ],
    });
    await provider.waitCi({ earlyReview: {} });
    expect(bodies).toEqual([]);
  });

  test('after a restart the early review in flight is adopted, not started twice', async () => {
    const { provider, bodies, stored } = reviewing({
      says: [[passOf(SHA_A)]],
      launched: 'rev-old',
    });
    await provider.waitCi({ earlyReview: {} });
    await settle();
    expect(bodies).toEqual([]);
    expect(stored()).toMatchObject([{ threadId: 'rev-old' }]);
  });

  test('the checks do not wait for the review, and a red build is still red', async () => {
    const { gate } = gates();
    const { provider } = reviewing({ says: [[passOf(SHA_A)]], gate });
    // The reviewer never finishes here; wait_ci answers all the same.
    expect(await provider.waitCi({ earlyReview: {} })).toMatchObject({ ok: true });
  });
});

describe("the factory's review limit", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  test('a review takes a slot for its commit and gives it back with its verdict', async () => {
    const taken: string[] = [];
    let released = 0;
    const { provider } = reviewing({
      says: [[passOf(SHA_A)]],
      slot: async (holder) => {
        taken.push(holder);
        return () => {
          released += 1;
        };
      },
    });
    await provider.review!({});
    expect(taken).toEqual([SHA_A.slice(0, 12)]);
    expect(released).toBe(1);
  });

  test('no free slot: the early review does not start, and the checks do not wait for it', async () => {
    let grant!: (release: () => void) => void;
    const slot = new Promise<() => void>((resolve) => (grant = resolve));
    const { provider, bodies } = reviewing({ says: [[passOf(SHA_A)]], slot: () => slot });
    expect(await provider.waitCi({ earlyReview: {} })).toMatchObject({ ok: true });
    await settle();
    expect(bodies).toEqual([]);
    // A slot frees: the review starts, and the review step gets its verdict.
    grant(() => {});
    expect(await provider.review!({})).toMatchObject({ ok: true, output: 'pass' });
    expect(bodies).toHaveLength(1);
  });

  test('a slot granted after the commit was replaced is given back without a review', async () => {
    let head = SHA_A;
    let grantA!: (release: () => void) => void;
    let released = 0;
    const { provider, bodies } = reviewing({
      head: () => head,
      says: [[passOf(SHA_B)]],
      slot: (holder) =>
        holder === SHA_A.slice(0, 12)
          ? new Promise<() => void>((resolve) => (grantA = resolve))
          : Promise.resolve(() => {}),
    });
    await provider.waitCi({ earlyReview: {} });
    head = SHA_B;
    await provider.waitCi({ earlyReview: {} });
    grantA(() => {
      released += 1;
    });
    await settle();
    // Only commit B was reviewed; A's slot went back unused.
    expect(bodies).toHaveLength(1);
    expect(String(bodies[0]?.title)).toContain(SHA_B.slice(0, 8));
    expect(released).toBe(1);
  });
});

describe('a verdict on the pull request', () => {
  test('a pass is posted as a comment and a success status, and the run remembers both', async () => {
    const { provider, published, stored } = reviewing({ says: [[passOf(SHA_A)]] });
    await provider.review!({});
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ sha: SHA_A, allowsMerge: true, description: 'Passed' });
    expect(published[0]?.body).toContain('does not approve the pull request');
    expect(stored()).toMatchObject([{ published: true, statusPublished: true }]);
  });

  test('a fail lists its findings and sets a failing status', async () => {
    const { provider, published } = reviewing({ says: [[failOf(SHA_A)]] });
    await provider.review!({});
    expect(published[0]).toMatchObject({
      allowsMerge: false,
      description: 'Failed: 1 finding(s) to fix',
    });
    expect(published[0]?.body).toContain('**high** `src/sum.ts:3`: Negative numbers are dropped');
  });

  test('an installation without the new permission gets the comment only', async () => {
    const { provider, stored } = reviewing({ says: [[passOf(SHA_A)]], publishes: 'comment-only' });
    await provider.review!({});
    expect(stored()).toMatchObject([{ published: true, statusPublished: false }]);
  });

  test('publishing that fails changes nothing about the verdict', async () => {
    const { provider, stored } = reviewing({ says: [[passOf(SHA_A)]], publishes: 'fails' });
    expect(await provider.review!({})).toMatchObject({ ok: true, output: 'pass' });
    expect(stored()).toMatchObject([{ sha: SHA_A, verdict: 'pass' }]);
    expect(stored()[0]?.published).toBeUndefined();
  });

  test("a mention in the reviewer's words notifies nobody", async () => {
    const { provider, published } = reviewing({
      says: [[json({ sha: SHA_A, verdict: 'pass', summary: 'Ask @octocat to approve this.' })]],
    });
    await provider.review!({});
    expect(published[0]?.body).not.toContain('@octocat');
    expect(published[0]?.body).toContain('octocat');
  });
});

describe('what merge checks on entry', () => {
  const at = '2026-11-22T02:00:00.000Z';
  const pass = (sha: string) => ({ sha, verdict: 'pass' as const, findings: [], reviewedAt: at });
  const fail = (sha: string) => ({
    sha,
    verdict: 'fail' as const,
    findings: [{ severity: 'high' as const, title: 'Wrong' }],
    reviewedAt: at,
  });

  /** A provider at its merge step: green checks, head `SHA_A`, the given verdicts and files. */
  function merging(over: Partial<ProviderDeps> & { files?: PullRequestFile[] } = {}) {
    const merges: Array<{ sha?: string } | undefined> = [];
    const recorded: UpdateRunInput[] = [];
    const { files, ...deps } = over;
    const { provider } = providerWith(
      {
        pullHead: () => okAsync({ sha: SHA_A, baseRef: 'main', autoMerge: false }),
        changedFiles: () => okAsync({ files: files ?? [], truncated: false }),
        merge: (_pr, options) => {
          merges.push(options);
          return okAsync({
            kind: 'merged' as const,
            method: 'squash' as const,
            branchDeleted: false,
          });
        },
      },
      {
        record: async (input) => {
          recorded.push(input);
        },
        ...deps,
      },
    );
    // The proof gate has its own tests; these are about the review and the risk.
    const merge = (opts: { requireReview?: boolean } = {}) =>
      provider.merge({ requireRegressionProof: false, ...opts });
    return { merge, merges, recorded };
  }

  test('a reviewed, low-risk commit is merged as that commit', async () => {
    const { merge, merges } = merging({ reviews: [pass(SHA_A)] });
    expect(await merge()).toMatchObject({ ok: true, output: 'merged' });
    expect(merges).toMatchObject([{ sha: SHA_A }]);
  });

  // Green checks and whatever an external review bot left on the pull request
  // are checks like any other: only the flow's own review step is a review.
  test('green checks without a verdict of the review step: not merged, "no review"', async () => {
    const { merge, merges, recorded } = merging();
    const result = await merge();
    expect(result).toMatchObject({
      ok: false,
      metadata: { outcome: 'held', reason: MERGE_HOLD_REASONS.noReview },
    });
    expect(merges).toEqual([]);
    expect(recorded).toContainEqual({
      state: 'waiting_human',
      failureReason: MERGE_HOLD_REASONS.noReview,
    });
  });

  test('a pass of an older commit does not allow merging the new head', async () => {
    const { merge, merges } = merging({ reviews: [pass(SHA_B)] });
    expect(await merge()).toMatchObject({ metadata: { reason: MERGE_HOLD_REASONS.noReview } });
    expect(merges).toEqual([]);
  });

  test('a failed review is not merged, whatever path led to merge', async () => {
    const { merge, merges } = merging({ reviews: [fail(SHA_A)] });
    expect(await merge()).toMatchObject({
      ok: false,
      metadata: { reason: MERGE_HOLD_REASONS.reviewFailed },
    });
    expect(merges).toEqual([]);
  });

  test('require_review: false merges without a verdict', async () => {
    const { merge, merges } = merging();
    expect(await merge({ requireReview: false })).toMatchObject({ ok: true });
    expect(merges).toHaveLength(1);
  });

  test('a reviewed high-risk change waits for a person when the factory merges only low risk', async () => {
    const { merge, merges, recorded } = merging({
      reviews: [pass(SHA_A)],
      files: [changed('.github/workflows/ci.yml', ['+x'])],
    });
    const result = await merge();
    expect(result).toMatchObject({ ok: false, metadata: { reason: MERGE_HOLD_REASONS.highRisk } });
    expect(result.error).toContain('.github/workflows/ci.yml');
    expect(merges).toEqual([]);
    expect(recorded).toContainEqual({
      state: 'waiting_human',
      failureReason: MERGE_HOLD_REASONS.highRisk,
    });
  });

  test('a factory that merges every reviewed change merges a high-risk one', async () => {
    const { merge, merges } = merging({
      reviews: [pass(SHA_A)],
      files: [changed('.github/workflows/ci.yml', ['+x'])],
      autoMerge: 'all',
    });
    expect(await merge()).toMatchObject({ ok: true });
    expect(merges).toHaveLength(1);
  });

  test('a high-risk change is held even with the review gate off', async () => {
    const { merge, merges } = merging({ files: [changed('src/auth/session.ts', ['+x'])] });
    expect(await merge({ requireReview: false })).toMatchObject({
      metadata: { reason: MERGE_HOLD_REASONS.highRisk },
    });
    expect(merges).toEqual([]);
  });

  test('a merge GitHub refuses for a missing permission is a failed step with the reason, not a retry', async () => {
    const followUps: string[] = [];
    const { provider } = providerWith(
      {
        pullHead: () => okAsync({ sha: SHA_A, baseRef: 'main', autoMerge: false }),
        merge: () =>
          errAsync({
            kind: 'no-access' as const,
            message: "The factory's enabler can only read o/r; merging needs write access.",
          }),
      },
      {
        reviews: [pass(SHA_A)],
        continuation: {
          followUp: async (_threadId, content) => {
            followUps.push(content);
            return ok(undefined);
          },
          completedAt: async () => null,
          followedUpSince: async () => false,
        },
      },
    );
    const result = await provider.merge({ requireRegressionProof: false });
    expect(result).toMatchObject({ ok: false, metadata: { kind: 'no-access' } });
    expect(result.error).toContain('merging needs write access');
    expect(followUps).toEqual([]);
  });
});

describe('merge brings the branch up to date with its base first', () => {
  const at = '2026-11-22T02:00:00.000Z';
  const SHA_M = 'c'.repeat(40);
  const SHA_M2 = 'd'.repeat(40);
  const BASE_1 = 'e'.repeat(40);
  const reviewedA = { sha: SHA_A, verdict: 'pass' as const, findings: [], reviewedAt: at };

  interface LaneScript {
    /** How many commits behind its base each head is (default 0). */
    behind?: Record<string, number>;
    /** What update-branch answers for a head: the merge commit it makes, or a refusal. */
    updates?: Record<string, string | { kind: 'conflict' | 'refused'; reason: string }>;
    /** A commit's parents. */
    parents?: Record<string, string[]>;
    /** The checks of each head (default green). */
    checks?: Record<string, CiState>;
    reviews?: ProviderDeps['reviews'];
    /** Commits of the first that the second lacks (a rewritten history), by `first...second`. */
    lacks?: Record<string, number>;
    /** The base branch requires GitHub's merge queue: how adding to it and following it go. */
    queue?: {
      enqueue?: { kind: 'queued' } | { kind: 'head-moved' } | { kind: 'refused'; reason: string };
      state: 'merged' | 'not-queued' | 'closed';
    };
    /**
     * The flow proves the regression test: the runner proves the implementing
     * agent's worktree, which stays at the commit it pushed (SHA_A).
     */
    proof?: boolean;
    /** The pull request's head when the step starts (default SHA_A). */
    head?: string;
  }

  /** A runner that proves the implementing agent's worktree, which stays at SHA_A. */
  const workTreeProof: ProviderDeps['proof'] = {
    startProof: async () => ok({ proofId: 'p1', state: 'running' as const }),
    pollProof: async () =>
      ok({ state: 'done' as const, result: { verdict: 'pass', headSha: SHA_A } }),
  };

  function lane(script: LaneScript) {
    let head = script.head ?? SHA_A;
    const updates: string[] = [];
    const enqueued: string[] = [];
    const merges: Array<{ sha?: string } | undefined> = [];
    const recorded: UpdateRunInput[] = [];
    const followUps: string[] = [];
    const { provider } = providerWith(
      {
        pullHead: () => okAsync({ sha: head, baseRef: 'main', autoMerge: false }),
        baseDistance: (_pr, base, sha) => {
          // A commit of the base has nothing the base lacks.
          if (sha === BASE_1) return okAsync({ behindBy: 0, aheadBy: 0 });
          if (base === 'main') return okAsync({ behindBy: script.behind?.[sha] ?? 0, aheadBy: 1 });
          // The head compared with a commit reviewed before it.
          return okAsync({ behindBy: script.lacks?.[`${base}...${sha}`] ?? 0, aheadBy: 1 });
        },
        updateBranch: (_pr, sha) => {
          updates.push(sha);
          const answer = script.updates?.[sha];
          if (!answer) return okAsync({ kind: 'refused' as const, reason: 'unexpected' });
          if (typeof answer !== 'string') return okAsync(answer);
          head = answer;
          return okAsync({ kind: 'updating' as const });
        },
        commitParents: (_pr, sha) => okAsync(script.parents?.[sha] ?? []),
        mergeQueueRequired: () => okAsync(script.queue !== undefined),
        enqueue: (_pr, sha) => {
          enqueued.push(sha);
          return okAsync(script.queue?.enqueue ?? { kind: 'queued' as const });
        },
        queueState: () => okAsync(script.queue?.state ?? 'merged'),
        baseChanges: () =>
          okAsync({
            commits: [{ sha: BASE_1, title: 'fix: rounding (#12)' }],
            files: ['src/sum.ts', 'bun.lock'],
          }),
        changedFiles: () =>
          okAsync({
            files: [changed('src/sum.ts', ['+x']), changed('bun.lock', ['+y'])],
            truncated: false,
          }),
        ciState: () => okAsync(script.checks?.[head] ?? { kind: 'green' as const }),
        merge: (_pr, options) => {
          merges.push(options);
          return okAsync({
            kind: 'merged' as const,
            method: 'squash' as const,
            branchDeleted: false,
          });
        },
      },
      {
        reviews: script.reviews ?? [reviewedA],
        proof: script.proof ? workTreeProof : undefined,
        record: async (input) => {
          recorded.push(input);
        },
        continuation: {
          followUp: async (_threadId, content) => {
            followUps.push(content);
            return ok(undefined);
          },
          completedAt: async () => null,
          followedUpSince: async () => false,
        },
      },
    );
    const proofConfig = { rules: [{ globs: ['**/*.test.ts'], command: 'bun test {{files}}' }] };
    const merge = async () => {
      if (!script.proof) return provider.merge({ requireRegressionProof: false });
      const proved = await provider.regressionProof!(proofConfig);
      if (!proved.ok) return proved;
      return provider.merge({ regressionProof: proofConfig });
    };
    const reviews = () => {
      const writes = recorded.flatMap((input) => (input.reviews ? [input.reviews] : []));
      return writes.at(-1) ?? [];
    };
    return { merge, merges, updates, reviews, recorded, followUps, enqueued };
  }

  test('a head that has its base is merged without touching the branch', async () => {
    const { merge, merges, updates } = lane({});
    expect(await merge()).toMatchObject({ ok: true, output: 'merged' });
    expect(updates).toEqual([]);
    expect(merges).toMatchObject([{ sha: SHA_A }]);
  });

  // Two runs green on the same old base: the second is merged only once its
  // checks are green on a commit that has what the first one merged.
  test('green on an old base: the base is merged in, the checks pass again, and that commit is merged', async () => {
    const { merge, merges, updates, reviews } = lane({
      behind: { [SHA_A]: 1 },
      updates: { [SHA_A]: SHA_M },
      parents: { [SHA_M]: [SHA_A, BASE_1] },
    });
    expect(await merge()).toMatchObject({ ok: true, output: 'merged' });
    expect(updates).toEqual([SHA_A]);
    expect(merges).toMatchObject([{ sha: SHA_M }]);
    // Only base changes came in: the review of A stands for the merge commit, no new review.
    expect(reviews()).toMatchObject([
      { sha: SHA_A, verdict: 'pass' },
      { sha: SHA_M, verdict: 'pass', carriedFrom: SHA_A },
    ]);
  });

  // The proof ran on the implementing agent's worktree, which stays at A: proving
  // the merge commit again only proves A once more, so the proof is carried.
  test('with a regression proof: the proof of A holds for the merge commit that only brought the base in', async () => {
    const { merge, merges, recorded } = lane({
      behind: { [SHA_A]: 1 },
      updates: { [SHA_A]: SHA_M },
      parents: { [SHA_M]: [SHA_A, BASE_1] },
      proof: true,
    });
    expect(await merge()).toMatchObject({ ok: true, output: 'merged' });
    expect(merges).toMatchObject([{ sha: SHA_M }]);
    const proofs = recorded.flatMap((input) =>
      input.regressionProof ? [input.regressionProof] : [],
    );
    expect(proofs.at(-1)).toMatchObject({ headSha: SHA_M, carriedFrom: SHA_A, verdict: 'pass' });
  });

  // Retried or resumed after the lane already updated the branch: nothing is
  // brought in now, and the proof run again only proves A once more.
  test('with a regression proof: a run resumed on the merge commit merges it on the proof of A', async () => {
    const { merge, merges, updates, recorded } = lane({
      head: SHA_M,
      parents: { [SHA_M]: [SHA_A, BASE_1] },
      reviews: [reviewedA, { ...reviewedA, sha: SHA_M, carriedFrom: SHA_A }],
      proof: true,
    });
    expect(await merge()).toMatchObject({ ok: true, output: 'merged' });
    expect(updates).toEqual([]);
    expect(merges).toMatchObject([{ sha: SHA_M }]);
    const proofs = recorded.flatMap((input) =>
      input.regressionProof ? [input.regressionProof] : [],
    );
    expect(proofs.at(-1)).toMatchObject({ headSha: SHA_M, carriedFrom: SHA_A });
  });

  test('with a regression proof: a head that is not a base merge of the proved commit is refused', async () => {
    const { merge, merges } = lane({
      head: SHA_M,
      parents: { [SHA_M]: [SHA_A, 'f'.repeat(40)] },
      reviews: [reviewedA, { ...reviewedA, sha: SHA_M, carriedFrom: SHA_A }],
      proof: true,
    });
    expect(await merge()).toMatchObject({ ok: false });
    expect(merges).toEqual([]);
  });

  test('the base moves again while the checks run: it is merged in again before the merge', async () => {
    const { merge, merges, updates } = lane({
      behind: { [SHA_A]: 1, [SHA_M]: 1 },
      updates: { [SHA_A]: SHA_M, [SHA_M]: SHA_M2 },
      parents: { [SHA_M]: [SHA_A, BASE_1], [SHA_M2]: [SHA_M, BASE_1] },
    });
    expect(await merge()).toMatchObject({ ok: true, output: 'merged' });
    expect(updates).toEqual([SHA_A, SHA_M]);
    expect(merges).toMatchObject([{ sha: SHA_M2 }]);
  });

  test('checks that fail on the updated branch go back to the implementer, and nothing is merged', async () => {
    const { merge, merges } = lane({
      behind: { [SHA_A]: 1 },
      updates: { [SHA_A]: SHA_M },
      parents: { [SHA_M]: [SHA_A, BASE_1] },
      checks: {
        [SHA_M]: {
          kind: 'failing',
          checks: [{ name: 'test', conclusion: 'failure', excerpt: 'expected 3, got 2' }],
        },
      },
    });
    const result = await merge();
    expect(result).toMatchObject({
      ok: true,
      output: 'sent_back',
      metadata: { outcome: 'sent_back', why: 'checks' },
    });
    expect(String(result.metadata?.feedback)).toContain('after `main` was merged into the branch');
    expect(String(result.metadata?.feedback)).toContain('expected 3, got 2');
    expect(merges).toEqual([]);
  });

  test('a conflict goes back with what merged first, the files on both sides and the lockfile rule', async () => {
    const { merge, merges } = lane({
      behind: { [SHA_A]: 1 },
      updates: { [SHA_A]: { kind: 'conflict', reason: 'merge conflict between base and head' } },
    });
    const result = await merge();
    expect(result).toMatchObject({ ok: true, metadata: { outcome: 'sent_back', why: 'conflict' } });
    const feedback = String(result.metadata?.feedback);
    expect(feedback).toContain('conflicts with `main`');
    expect(feedback).toContain(`${BASE_1.slice(0, 8)} fix: rounding (#12)`);
    expect(feedback).toContain('- src/sum.ts');
    expect(feedback).toContain('regenerate it with the package manager');
    expect(feedback).toContain('Never rebase and never force push');
    expect(merges).toEqual([]);
  });

  test('a refusal that is not a conflict fails the step: no merge, and no agent is asked', async () => {
    const { merge, merges, followUps } = lane({
      behind: { [SHA_A]: 1 },
      updates: { [SHA_A]: { kind: 'refused', reason: 'Protected branch update failed' } },
    });
    const result = await merge();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Protected branch update failed');
    expect(merges).toEqual([]);
    expect(followUps).toEqual([]);
  });

  test('a new head that is not a merge of the reviewed commit with the base is not merged', async () => {
    const { merge, merges, reviews } = lane({
      behind: { [SHA_A]: 1 },
      updates: { [SHA_A]: SHA_M },
      // Someone pushed their own commit instead: one parent, not a base merge.
      parents: { [SHA_M]: [SHA_B] },
    });
    const result = await merge();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('is not a merge of');
    expect(merges).toEqual([]);
    expect(reviews()).toEqual([]);
  });

  describe("where the base branch requires GitHub's merge queue", () => {
    test('the pull request is enqueued at its reviewed commit, and GitHub merges it', async () => {
      const { merge, merges, updates, enqueued, recorded } = lane({
        behind: { [SHA_A]: 3 },
        queue: { state: 'merged' },
      });
      expect(await merge()).toMatchObject({
        ok: true,
        output: 'merged',
        metadata: { outcome: 'merged', via: 'merge-queue' },
      });
      expect(enqueued).toEqual([SHA_A]);
      // The queue tests it on the base: the factory neither updates the branch nor merges.
      expect(updates).toEqual([]);
      expect(merges).toEqual([]);
      expect(recorded).toContainEqual({ state: 'merged', currentStep: null });
    });

    test('taken out of the queue: what fails with the base goes to the implementer', async () => {
      const { merge, merges } = lane({
        behind: { [SHA_A]: 1 },
        updates: { [SHA_A]: SHA_M },
        parents: { [SHA_M]: [SHA_A, BASE_1] },
        checks: {
          [SHA_M]: {
            kind: 'failing',
            checks: [{ name: 'test', conclusion: 'failure', excerpt: 'expected 3, got 2' }],
          },
        },
        queue: { state: 'not-queued' },
      });
      const result = await merge();
      expect(result).toMatchObject({ ok: true, metadata: { outcome: 'sent_back', why: 'checks' } });
      expect(String(result.metadata?.feedback)).toContain('expected 3, got 2');
      expect(merges).toEqual([]);
    });

    test('taken out of the queue for no reason the factory can show: the run is left for a person', async () => {
      const { merge, followUps } = lane({ queue: { state: 'not-queued' } });
      const result = await merge();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("GitHub's merge queue removed the pull request");
      expect(followUps).toEqual([]);
    });

    test('a refusal to enqueue fails the step with its reason', async () => {
      const { merge, merges } = lane({
        queue: {
          enqueue: { kind: 'refused', reason: 'Required status check "ci" is expected' },
          state: 'not-queued',
        },
      });
      const result = await merge();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Required status check "ci" is expected');
      expect(merges).toEqual([]);
    });

    test('an unreviewed commit is not enqueued', async () => {
      const { merge, enqueued } = lane({ reviews: [], queue: { state: 'merged' } });
      expect(await merge()).toMatchObject({
        ok: false,
        metadata: { reason: MERGE_HOLD_REASONS.noReview },
      });
      expect(enqueued).toEqual([]);
    });
  });

  test('a branch rewritten so it no longer contains the reviewed commit waits for a person', async () => {
    const { merge, merges, recorded } = lane({
      reviews: [{ sha: SHA_B, verdict: 'pass', findings: [], reviewedAt: at }, reviewedA],
      // The head (A) lacks two commits of B, which was reviewed before: a force push.
      lacks: { [`${SHA_B}...${SHA_A}`]: 2 },
    });
    expect(await merge()).toMatchObject({
      ok: false,
      metadata: { reason: MERGE_HOLD_REASONS.rewritten },
    });
    expect(merges).toEqual([]);
    expect(recorded).toContainEqual({
      state: 'waiting_human',
      failureReason: MERGE_HOLD_REASONS.rewritten,
    });
  });
});

// Change factory-agent-roles, task 7.11: whether the reviewer pays, and why runs
// stop being unattended, are counted on the run.
describe('what a run counts about its review and its merge', () => {
  const lastMetrics = (recorded: UpdateRunInput[]) =>
    recorded.flatMap((input) => (input.metrics ? [input.metrics] : [])).at(-1);

  test('a passed review counts one review and no fail', async () => {
    const { provider, recorded } = reviewing({ says: [[passOf(SHA_A)]] });
    await provider.review!({});
    expect(lastMetrics(recorded)).toMatchObject({ reviews: 1, reviewFails: 0 });
  });

  test('a failed review counts a review and a fail', async () => {
    const { provider, recorded } = reviewing({ says: [[failOf(SHA_A)]] });
    await provider.review!({});
    expect(lastMetrics(recorded)).toMatchObject({ reviews: 1, reviewFails: 1 });
  });

  test('a high-risk run held at the merge counts a hold, after its review', async () => {
    const { provider, recorded } = reviewing({
      says: [[passOf(SHA_A)]],
      files: [changed('.github/workflows/ci.yml', ['+x'])],
    });
    await provider.review!({});
    await provider.merge({ requireRegressionProof: false });
    expect(lastMetrics(recorded)).toMatchObject({ reviews: 1, reviewFails: 0, mergeHolds: 1 });
    expect(recorded).toContainEqual({
      state: 'waiting_human',
      failureReason: MERGE_HOLD_REASONS.highRisk,
    });
  });
});

// Change factory-agent-roles, phase 2: the contract reaches the reviewer and the risk class.
describe('a run with a contract', () => {
  const triage = {
    decision: 'ready' as const,
    at: '2026-11-22T00:00:00.000Z',
    contract: {
      acceptanceCriteria: ['Negative numbers are summed'],
      likelyPaths: ['src/sum.ts'],
      riskHints: ['changes the rounding of every invoice'],
    },
  };

  test('the reviewer judges against the contract, not the issue', async () => {
    const { provider, bodies } = reviewing({ says: [[passOf(SHA_A)]], triage });
    await provider.review!({});
    const prompt = String(bodies[0]?.prompt);
    expect(prompt).toContain('The change must meet this contract');
    expect(prompt).toContain('- Negative numbers are summed');
    expect(prompt).not.toContain('https://github.com/o/r/issues/7');
    expect(prompt).not.toContain('IMPLEMENTER-PRIVATE-NOTES');
  });

  test('a risk hint of the contract makes the change high risk, whatever the review says', async () => {
    const { provider, recorded } = reviewing({
      says: [[passOf(SHA_A)]],
      triage,
      files: [changed('src/sum.ts', ['+return a + b;'])],
    });
    await provider.review!({});
    const result = await provider.merge({ requireRegressionProof: false });
    expect(result).toMatchObject({ ok: false, metadata: { reason: MERGE_HOLD_REASONS.highRisk } });
    expect(result.error).toContain(
      'the contract names a risk: changes the rounding of every invoice',
    );
    expect(recorded.some((input) => input.risk?.level === 'high')).toBe(true);
  });
});
