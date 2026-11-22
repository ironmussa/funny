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
