/**
 * The factory's pull request port over a fake GitHub REST: CI verdicts, a merge
 * only on green, the enabler-capped token (read level cannot merge), and the
 * actionable error when no token can be minted.
 */
import { describe, expect, test } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

import { createFactoryPullRequests } from '../../../services/factory/factory-pull-requests.js';
import type { AccessLevel, IssueError } from '../../../services/github-app/token-issuer.js';
import { fakeFetch } from '../../helpers/builders-services.js';

const pr = { repo: 'o/r', number: 7, branch: 'factory/7', userId: 'alice', projectId: 'p1' };
const pull = {
  node_id: 'PR_1',
  mergeable: true,
  mergeable_state: 'clean',
  head: { sha: 'abc' },
};

function fakeGithub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = fakeFetch(async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`;
    calls.push(key);
    if (!(key in routes)) return new Response('not found', { status: 404 });
    const body = routes[key];
    if (body instanceof Response) return body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  });
  return { calls, fetchImpl };
}

const checks = (conclusion: string | null, status = 'completed') => ({
  'GET /repos/o/r/pulls/7': pull,
  'GET /repos/o/r/commits/abc/check-runs?per_page=100': {
    check_runs: [{ id: 1, name: 'build', status, conclusion }],
  },
  'GET /repos/o/r/commits/abc/status': { statuses: [] },
});

function portFor(
  routes: Record<string, unknown>,
  token: { level: AccessLevel } | IssueError = { level: 'write' },
) {
  const gh = fakeGithub(routes);
  const recorded: Array<{ spec: { kind: string; userId: string }; outcome: any }> = [];
  const prs = createFactoryPullRequests({
    issue: () =>
      'kind' in token
        ? errAsync(token)
        : okAsync({ token: 'tok', expiresAt: '', repo: 'o/r', level: token.level }),
    ownerToken: async () => 'pat_alice',
    fetch: gh.fetchImpl,
    activities: {
      recordServerActivity: async (spec, outcome) => {
        recorded.push({ spec, outcome });
      },
    },
  });
  return { prs, calls: gh.calls, recorded };
}

describe('factory pull requests', () => {
  test('reads whether the pull request is open, merged or closed, with a read token', async () => {
    const stateOf = async (fields: Record<string, unknown>) =>
      (
        await portFor(
          { 'GET /repos/o/r/pulls/7': { ...pull, ...fields } },
          { level: 'read' },
        ).prs.prState(pr)
      )._unsafeUnwrap();
    expect(await stateOf({ state: 'open', merged: false })).toBe('open');
    expect(await stateOf({ state: 'closed', merged: true })).toBe('merged');
    expect(await stateOf({ state: 'closed', merged: false })).toBe('closed');
  });

  test('reports green, red and pending CI', async () => {
    expect((await portFor(checks('success')).prs.ciState(pr))._unsafeUnwrap()).toEqual({
      kind: 'green',
    });
    expect((await portFor(checks('failure')).prs.ciState(pr))._unsafeUnwrap().kind).toBe('failing');
    expect((await portFor(checks(null, 'in_progress')).prs.ciState(pr))._unsafeUnwrap()).toEqual({
      kind: 'pending',
    });
  });

  test('a PR whose checks are not green is not merged, and no merge call is made', async () => {
    const { prs, calls } = portFor(checks('failure'));
    const outcome = (await prs.merge(pr))._unsafeUnwrap();
    expect(outcome.kind).toBe('not-green');
    expect(calls.some((call) => call.includes('/merge') || call.includes('graphql'))).toBe(false);
  });

  test('a green PR is merged with the preferred method and its branch deleted', async () => {
    const { prs, calls } = portFor({
      ...checks('success'),
      'GET /repos/o/r': {
        allow_squash_merge: true,
        allow_merge_commit: true,
        allow_auto_merge: false,
      },
      'PUT /repos/o/r/pulls/7/merge': { merged: true },
      'DELETE /repos/o/r/git/refs/heads/factory/7': {},
    });
    const outcome = (await prs.merge(pr, { method: 'merge', deleteBranch: true }))._unsafeUnwrap();
    expect(outcome).toEqual({ kind: 'merged', method: 'merge', branchDeleted: true });
    expect(calls).toContain('PUT /repos/o/r/pulls/7/merge');
  });

  const mergeRoutes = {
    ...checks('success'),
    'GET /repos/o/r': {
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_auto_merge: false,
    },
    'PUT /repos/o/r/pulls/7/merge': { merged: true },
  };

  test('a merge is a factory.merge activity of the enabler with its effects', async () => {
    const { prs, recorded } = portFor({
      ...mergeRoutes,
      'DELETE /repos/o/r/git/refs/heads/factory/7': {},
    });
    await prs.merge(pr, { method: 'merge', deleteBranch: true });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.spec).toMatchObject({ kind: 'factory.merge', userId: 'alice' });
    expect(recorded[0]!.outcome).toEqual({
      ok: true,
      effects: [
        { effect: 'pr-merged', target: 'o/r#7' },
        { effect: 'remote-branch-deleted', target: 'factory/7' },
      ],
    });
  });

  test('a branch that cannot be deleted fails the activity, not the merge', async () => {
    const { prs, recorded } = portFor({
      ...mergeRoutes,
      'DELETE /repos/o/r/git/refs/heads/factory/7': new Response('protected', { status: 403 }),
    });
    const outcome = (await prs.merge(pr, { method: 'merge', deleteBranch: true }))._unsafeUnwrap();
    expect(outcome).toEqual({ kind: 'merged', method: 'merge', branchDeleted: false });
    expect(recorded[0]!.outcome).toMatchObject({
      ok: false,
      effects: [{ effect: 'pr-merged', target: 'o/r#7' }],
    });
    expect(recorded[0]!.outcome.error).toContain('factory/7');
  });

  test('a PR not merged records nothing', async () => {
    const { prs, recorded } = portFor(checks('failure'));
    await prs.merge(pr);
    expect(recorded).toHaveLength(0);
  });

  test('an enabler who can only read the repository cannot merge', async () => {
    const { prs, calls } = portFor(checks('success'), { level: 'read' });
    const merged = await prs.merge(pr);
    expect(merged.isErr() && merged.error.kind).toBe('no-access');
    expect(calls).toEqual([]);
    // Reading the CI is still allowed.
    expect((await prs.ciState(pr)).isOk()).toBe(true);
  });

  test('no App installed is an actionable error, and GitHub is never called', async () => {
    const { prs, calls } = portFor(checks('success'), {
      kind: 'not-installed',
      message: 'not installed',
    });
    const ci = await prs.ciState(pr);
    expect(ci.isErr() && ci.error).toMatchObject({
      kind: 'not-installed',
      message: expect.stringContaining('Install it on that repository'),
    });
    expect(calls).toEqual([]);
  });
});

describe("factory pull requests: closing a replaced run's pull request", () => {
  const by = { issueNumber: 489, prNumber: 511 };
  const stacked = 'GET /repos/o/r/pulls?base=factory%2F7&state=open&per_page=100';
  const open = {
    'GET /repos/o/r/pulls/7': { ...pull, state: 'open', merged: false, base: { ref: 'master' } },
    'POST /repos/o/r/issues/7/comments': {},
    'PATCH /repos/o/r/pulls/7': {},
    [stacked]: [],
    'DELETE /repos/o/r/git/refs/heads/factory/7': {},
  };

  test('an open one is commented, closed and its branch deleted, as an activity of the enabler', async () => {
    const { prs, calls, recorded } = portFor(open);
    const outcome = (await prs.closeReplaced!(pr, by))._unsafeUnwrap();
    expect(outcome).toEqual({ kind: 'closed', branchDeleted: true });
    // The comment says why before the close; the branch goes last.
    expect(calls.filter((call) => !call.startsWith('GET'))).toEqual([
      'POST /repos/o/r/issues/7/comments',
      'PATCH /repos/o/r/pulls/7',
      'DELETE /repos/o/r/git/refs/heads/factory/7',
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.spec).toMatchObject({
      kind: 'factory.close-pr',
      userId: 'alice',
      input: { prNumber: 7, issueNumber: 489, replacedBy: 511 },
    });
    expect(recorded[0]!.outcome).toEqual({
      ok: true,
      effects: [
        { effect: 'pr-closed', target: 'o/r#7' },
        { effect: 'remote-branch-deleted', target: 'factory/7' },
      ],
    });
  });

  test('a merged one is left as it is: no comment, no close, its branch stays', async () => {
    const { prs, calls, recorded } = portFor({
      ...open,
      'GET /repos/o/r/pulls/7': { ...pull, state: 'closed', merged: true, base: { ref: 'master' } },
    });
    expect((await prs.closeReplaced!(pr, by))._unsafeUnwrap()).toEqual({ kind: 'merged' });
    expect(calls).toEqual(['GET /repos/o/r/pulls/7']);
    expect(recorded).toHaveLength(0);
  });

  test('one already closed only loses its branch', async () => {
    const { prs, calls } = portFor({
      ...open,
      'GET /repos/o/r/pulls/7': {
        ...pull,
        state: 'closed',
        merged: false,
        base: { ref: 'master' },
      },
    });
    expect((await prs.closeReplaced!(pr, by))._unsafeUnwrap()).toEqual({
      kind: 'already-closed',
      branchDeleted: true,
    });
    expect(calls).not.toContain('PATCH /repos/o/r/pulls/7');
    expect(calls).not.toContain('POST /repos/o/r/issues/7/comments');
  });

  test('a branch that cannot be deleted fails the activity, not the close', async () => {
    const { prs, recorded } = portFor({
      ...open,
      'DELETE /repos/o/r/git/refs/heads/factory/7': new Response('nope', { status: 403 }),
    });
    expect((await prs.closeReplaced!(pr, by))._unsafeUnwrap()).toEqual({
      kind: 'closed',
      branchDeleted: false,
    });
    expect(recorded[0]!.outcome).toMatchObject({
      ok: false,
      effects: [{ effect: 'pr-closed', target: 'o/r#7' }],
    });
  });

  test('an enabler who can only read the repository closes nothing', async () => {
    const { prs, calls } = portFor(open, { level: 'read' });
    expect((await prs.closeReplaced!(pr, by))._unsafeUnwrapErr().kind).toBe('no-access');
    expect(calls).toEqual([]);
  });
});

describe('factory pull requests: the proof gate (task 4.4)', () => {
  /** A route answering a status instead of a 200 body. */
  interface StatusRoute {
    status: number;
    body?: Record<string, string>;
  }
  const isStatus = (v: unknown): v is StatusRoute =>
    typeof v === 'object' && v !== null && 'status' in v;

  /** A GitHub that answers `routes`; `{ status }` routes answer that status. */
  function gated(routes: Record<string, unknown>, opts: { appId?: string | null } = {}) {
    const calls: Array<{ key: string; body?: unknown; auth?: string }> = [];
    const fetchImpl = fakeFetch(async (url, init) => {
      const key = `${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`;
      const headers = new Headers(init?.headers);
      calls.push({
        key,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: headers.get('authorization') ?? undefined,
      });
      if (!(key in routes)) return new Response('not found', { status: 404 });
      const routed = routes[key];
      // A function route answers from the calls made so far (a state that changes mid-way).
      const route: unknown =
        typeof routed === 'function' ? routed(calls.map((call) => call.key)) : routed;
      if (isStatus(route)) {
        return new Response(JSON.stringify(route.body ?? { message: 'refused' }), {
          status: route.status,
        });
      }
      return new Response(JSON.stringify(route), { status: 200 });
    });
    const prs = createFactoryPullRequests({
      issue: () => okAsync({ token: 'tok-repo', expiresAt: '', repo: 'o/r', level: 'write' }),
      ownerToken: async () => 'pat_alice',
      issueCheckPublisher: () =>
        okAsync({ token: 'tok-checks', expiresAt: '', repo: 'o/r', level: 'write' }),
      issueStatusPublisher: () =>
        okAsync({ token: 'tok-statuses', expiresAt: '', repo: 'o/r', level: 'write' }),
      appId: () => okAsync(opts.appId === undefined ? '999' : opts.appId),
      fetch: fetchImpl,
    });
    return { prs, calls };
  }

  const openPull = { ...pull, state: 'open', base: { ref: 'main' }, auto_merge: null };
  const green = {
    'GET /repos/o/r/pulls/7': openPull,
    'GET /repos/o/r/commits/abc/check-runs?per_page=100': {
      check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }],
    },
    'GET /repos/o/r/commits/abc/status': { statuses: [] },
  };
  const heldBy = (integrationId: number) => ({
    'GET /repos/o/r/rules/branches/main?per_page=100': [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            { context: 'funny/regression-proof', integration_id: integrationId },
          ],
        },
      },
    ],
  });
  const autoMerge = {
    'GET /repos/o/r': { allow_squash_merge: true, allow_auto_merge: true },
    'POST /graphql': { data: { enablePullRequestAutoMerge: { clientMutationId: null } } },
  };

  test('the pull head carries its base branch and auto-merge state', async () => {
    const { prs } = gated({ 'GET /repos/o/r/pulls/7': { ...openPull, auto_merge: {} } });
    expect((await prs.pullHead(pr))._unsafeUnwrap()).toEqual({
      sha: 'abc',
      baseRef: 'main',
      autoMerge: true,
    });
  });

  test('a pinned merge merges the proved commit directly', async () => {
    const { prs, calls } = gated({ ...green, 'PUT /repos/o/r/pulls/7/merge': { merged: true } });
    const merged = (
      await prs.merge(pr, { sha: 'abc', method: 'squash', autoMergeWhenHeld: true })
    )._unsafeUnwrap();
    expect(merged.kind).toBe('merged');
    expect(calls.find((c) => c.key === 'PUT /repos/o/r/pulls/7/merge')?.body).toMatchObject({
      sha: 'abc',
    });
    expect(calls.some((c) => c.key === 'POST /graphql')).toBe(false);
  });

  test('refused for a requirement and held by GitHub (pinned to this App): auto-merge', async () => {
    const { prs, calls } = gated({
      ...green,
      ...heldBy(999),
      ...autoMerge,
      'PUT /repos/o/r/pulls/7/merge': { status: 405 },
    });
    const merged = (
      await prs.merge(pr, { sha: 'abc', method: 'squash', autoMergeWhenHeld: true })
    )._unsafeUnwrap();
    expect(merged.kind).toBe('auto-merge-enabled');
    // Enabled for the proved commit only: GitHub refuses it if the head is another.
    const mutation = calls.find((c) => c.key === 'POST /graphql')?.body as {
      query: string;
      variables: Record<string, string>;
    };
    expect(mutation.query).toContain('expectedHeadOid: $head');
    expect(mutation.variables.head).toBe('abc');
  });

  test('a push between the held check and enabling auto-merge enables nothing', async () => {
    const { prs, calls } = gated({
      ...green,
      ...heldBy(999),
      ...autoMerge,
      'PUT /repos/o/r/pulls/7/merge': { status: 405 },
      // The head is the proved commit until auto-merge is about to be enabled
      // (the repository settings were just read), then someone pushed.
      'GET /repos/o/r/pulls/7': (seen: string[]) =>
        seen.includes('GET /repos/o/r') ? { ...openPull, head: { sha: 'pushed' } } : openPull,
    });
    const merged = (
      await prs.merge(pr, { sha: 'abc', method: 'squash', autoMergeWhenHeld: true })
    )._unsafeUnwrap();
    expect(merged.kind).toBe('not-mergeable');
    expect(calls.some((c) => c.key === 'GET /repos/o/r')).toBe(true);
    expect(calls.some((c) => c.key === 'POST /graphql')).toBe(false);
  });

  test('not held (required from another App, or not published): no auto-merge, says how', async () => {
    const other = gated({
      ...green,
      ...heldBy(15368),
      ...autoMerge,
      'PUT /repos/o/r/pulls/7/merge': { status: 405 },
    });
    const merged = (
      await other.prs.merge(pr, { sha: 'abc', method: 'squash', autoMergeWhenHeld: true })
    )._unsafeUnwrap();
    expect(merged).toMatchObject({ kind: 'not-mergeable' });
    expect(merged.kind === 'not-mergeable' && merged.reason).toContain(
      'require the "funny/regression-proof" check from this GitHub App on main',
    );
    expect(other.calls.some((c) => c.key === 'POST /graphql')).toBe(false);

    const unpublished = gated({
      ...green,
      ...heldBy(999),
      ...autoMerge,
      'PUT /repos/o/r/pulls/7/merge': { status: 405 },
    });
    await unpublished.prs.merge(pr, { sha: 'abc', method: 'squash', autoMergeWhenHeld: false });
    expect(unpublished.calls.some((c) => c.key === 'POST /graphql')).toBe(false);
  });

  test('a head that moved is never auto-merged', async () => {
    const { prs, calls } = gated({
      ...green,
      ...heldBy(999),
      ...autoMerge,
      'PUT /repos/o/r/pulls/7/merge': { status: 409 },
    });
    const merged = (
      await prs.merge(pr, { sha: 'abc', method: 'squash', autoMergeWhenHeld: true })
    )._unsafeUnwrap();
    expect(merged.kind).toBe('not-mergeable');
    expect(calls.some((c) => c.key === 'POST /graphql')).toBe(false);
  });

  test('the check is published with the check-only token, on the proved commit', async () => {
    const { prs, calls } = gated({
      'POST /repos/o/r/check-runs': { id: 1, html_url: 'https://github.com/o/r/runs/1' },
    });
    const published = await prs.publishProofCheck(pr, {
      headSha: 'abc',
      conclusion: 'success',
      title: 'The changed tests catch the bug',
      summary: 'ok',
    });
    expect(published.isOk()).toBe(true);
    const call = calls.find((c) => c.key === 'POST /repos/o/r/check-runs');
    expect(call?.auth).toBe('token tok-checks');
    expect(call?.body).toMatchObject({
      name: 'funny/regression-proof',
      head_sha: 'abc',
      conclusion: 'success',
    });
  });

  // Change factory-agent-roles: a review verdict on the pull request.
  describe('publishing a review verdict', () => {
    const review = {
      sha: 'abc',
      allowsMerge: true,
      body: '**funny review: Passed**',
      description: 'Passed',
    };

    test('a comment that never approves, then the status with the status-only token', async () => {
      const { prs, calls } = gated({
        'POST /repos/o/r/pulls/7/reviews': { id: 1 },
        'POST /repos/o/r/statuses/abc': { id: 2 },
      });
      expect((await prs.publishReview(pr, review))._unsafeUnwrap()).toEqual({ status: true });
      const comment = calls.find((c) => c.key === 'POST /repos/o/r/pulls/7/reviews');
      expect(comment?.auth).toBe('token tok-repo');
      expect(comment?.body).toEqual({
        commit_id: 'abc',
        body: '**funny review: Passed**',
        event: 'COMMENT',
      });
      const status = calls.find((c) => c.key === 'POST /repos/o/r/statuses/abc');
      expect(status?.auth).toBe('token tok-statuses');
      expect(status?.body).toEqual({
        state: 'success',
        context: 'funny/review',
        description: 'Passed',
      });
    });

    test('a fail sets a failure status', async () => {
      const { prs, calls } = gated({
        'POST /repos/o/r/pulls/7/reviews': { id: 1 },
        'POST /repos/o/r/statuses/abc': { id: 2 },
      });
      await prs.publishReview(pr, { ...review, allowsMerge: false, description: 'Failed' });
      const status = calls.find((c) => c.key === 'POST /repos/o/r/statuses/abc');
      expect(status?.body).toMatchObject({ state: 'failure' });
    });

    test('an installation without the new permission: the comment only', async () => {
      const { prs, calls } = gated({
        'POST /repos/o/r/pulls/7/reviews': { id: 1 },
        'POST /repos/o/r/statuses/abc': { status: 403 },
      });
      expect((await prs.publishReview(pr, review))._unsafeUnwrap()).toEqual({ status: false });
      expect(calls.some((c) => c.key === 'POST /repos/o/r/pulls/7/reviews')).toBe(true);
    });

    test('a verdict carried to a base-merge commit sets its status only, with no second comment', async () => {
      const { prs, calls } = gated({ 'POST /repos/o/r/statuses/abc': { id: 2 } });
      const { body: _body, ...carried } = review;
      expect((await prs.publishReview(pr, carried))._unsafeUnwrap()).toEqual({ status: true });
      expect(calls.some((c) => c.key === 'POST /repos/o/r/pulls/7/reviews')).toBe(false);
      expect(calls.find((c) => c.key === 'POST /repos/o/r/statuses/abc')?.body).toMatchObject({
        state: 'success',
        context: 'funny/review',
      });
    });

    test('a comment GitHub refuses is the error, and no status is set', async () => {
      const { prs, calls } = gated({ 'POST /repos/o/r/pulls/7/reviews': { status: 422 } });
      expect((await prs.publishReview(pr, review)).isErr()).toBe(true);
      expect(calls.some((c) => c.key.includes('/statuses/'))).toBe(false);
    });
  });
});
