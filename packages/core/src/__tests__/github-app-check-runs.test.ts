/**
 * GitHub check runs and branch protection helpers for the regression proof gate.
 */

import { describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import { createRepoCheckOps } from '../github-app/check-runs.js';
import { createRepoGithub } from '../github-app/repo-github.js';
import { fakeFetch } from './helpers/test-helpers.js';

function fakeGithub(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchImpl = fakeFetch(async (url, init) => {
    const path = url.replace('https://api.github.com', '');
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body) body = JSON.parse(init.body as string);
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response('not found', { status: 404 });
    const val = routes[key];
    if (typeof val === 'number') return new Response('error', { status: val });
    return new Response(JSON.stringify(val), { status: 200 });
  });
  return { calls, fetchImpl };
}

function opsFor(routes: Record<string, unknown>) {
  const gh = fakeGithub(routes);
  const ops = createRepoCheckOps(
    createRepoGithub({ tokenFor: () => okAsync('tok-1'), fetch: gh.fetchImpl }),
  );
  return { ops, calls: gh.calls };
}

describe('pinnedMerge', () => {
  test('merges the exact SHA and returns merged', async () => {
    const { ops, calls } = opsFor({
      'PUT /repos/o/r/pulls/7/merge': { merged: true },
    });
    const result = (await ops.pinnedMerge('o/r', 7, 'abc123', 'squash'))._unsafeUnwrap();
    expect(result).toEqual({ kind: 'merged', method: 'squash' });
    expect(calls[0].body).toMatchObject({ merge_method: 'squash', sha: 'abc123' });
  });

  test('returns not-mergeable when GitHub refuses (409)', async () => {
    const { ops } = opsFor({
      'PUT /repos/o/r/pulls/7/merge': 409,
    });
    const result = (await ops.pinnedMerge('o/r', 7, 'abc123', 'squash'))._unsafeUnwrap();
    expect(result).toMatchObject({ kind: 'not-mergeable', headMoved: true });
  });

  test('returns not-mergeable when merge method not allowed (405)', async () => {
    const { ops } = opsFor({
      'PUT /repos/o/r/pulls/7/merge': 405,
    });
    const result = (await ops.pinnedMerge('o/r', 7, 'abc123', 'squash'))._unsafeUnwrap();
    expect(result).toMatchObject({ kind: 'not-mergeable', headMoved: false });
  });
});

describe('isBranchAhead', () => {
  test('returns ahead when the branch has commits ahead', async () => {
    const { ops } = opsFor({
      'GET /repos/o/r/compare/main...feature': { ahead_by: 3, behind_by: 0, status: 'ahead' },
    });
    const result = (await ops.isBranchAhead('o/r', 'main', 'feature'))._unsafeUnwrap();
    expect(result).toEqual({ ahead: true, aheadBy: 3 });
  });

  test('returns not ahead when the branch is at the same commit', async () => {
    const { ops } = opsFor({
      'GET /repos/o/r/compare/main...feature': { ahead_by: 0, behind_by: 0, status: 'identical' },
    });
    const result = (await ops.isBranchAhead('o/r', 'main', 'feature'))._unsafeUnwrap();
    expect(result).toEqual({ ahead: false, aheadBy: 0 });
  });

  test('returns not ahead when the branch does not exist (404)', async () => {
    const { ops } = opsFor({});
    const result = (await ops.isBranchAhead('o/r', 'main', 'nonexistent'))._unsafeUnwrap();
    expect(result).toEqual({ ahead: false, aheadBy: 0 });
  });
});

describe('createCheckRun', () => {
  test('creates a check run with the given conclusion', async () => {
    const { ops, calls } = opsFor({
      'POST /repos/o/r/check-runs': { id: 42, html_url: 'https://github.com/o/r/runs/42' },
    });
    const result = (
      await ops.createCheckRun({
        repo: 'o/r',
        headSha: 'abc123',
        name: 'funny/regression-proof',
        conclusion: 'success',
        summary: 'All tests pass',
      })
    )._unsafeUnwrap();
    expect(result).toEqual({ id: 42, url: 'https://github.com/o/r/runs/42' });
    expect(calls[0].body).toMatchObject({
      name: 'funny/regression-proof',
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'success',
    });
  });

  test('reports a permission error when the App lacks checks:write', async () => {
    const { ops } = opsFor({
      'POST /repos/o/r/check-runs': 403,
    });
    const result = await ops.createCheckRun({
      repo: 'o/r',
      headSha: 'abc123',
      name: 'funny/regression-proof',
      conclusion: 'success',
      summary: 'pass',
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().status).toBe(403);
  });
});

describe('isCheckHeldByApp', () => {
  const name = 'funny/regression-proof';
  const rules = (checks: Array<{ context: string; integration_id?: number }>) => [
    { type: 'pull_request', parameters: {} },
    { type: 'required_status_checks', parameters: { required_status_checks: checks } },
  ];

  test('held: a rule on the branch requires the check from this App', async () => {
    const { ops, calls } = opsFor({
      'GET /repos/o/r/rules/branches/main?per_page=100': rules([
        { context: name, integration_id: 999 },
      ]),
    });
    expect((await ops.isCheckHeldByApp('o/r', 'main', name, 999))._unsafeUnwrap()).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(['/repos/o/r/rules/branches/main?per_page=100']);
  });

  test('a branch name with a slash keeps it in the path', async () => {
    const { ops, calls } = opsFor({
      'GET /repos/o/r/rules/branches/release/1.x?per_page=100': rules([
        { context: name, integration_id: 999 },
      ]),
    });
    expect((await ops.isCheckHeldByApp('o/r', 'release/1.x', name, 999))._unsafeUnwrap()).toBe(
      true,
    );
    expect(calls.map((c) => c.path)).toEqual([
      '/repos/o/r/rules/branches/release/1.x?per_page=100',
    ]);
  });

  test('not held: required from any source, or from another App', async () => {
    for (const check of [{ context: name }, { context: name, integration_id: 15368 }]) {
      const { ops } = opsFor({
        'GET /repos/o/r/rules/branches/main?per_page=100': rules([check]),
        'GET /repos/o/r/branches/main': { protection: { required_status_checks: { checks: [] } } },
      });
      expect((await ops.isCheckHeldByApp('o/r', 'main', name, 999))._unsafeUnwrap()).toBe(false);
    }
  });

  test('held by classic branch protection pinned to this App', async () => {
    const { ops } = opsFor({
      'GET /repos/o/r/rules/branches/main?per_page=100': [],
      'GET /repos/o/r/branches/main': {
        protection: { required_status_checks: { checks: [{ context: name, app_id: 999 }] } },
      },
    });
    expect((await ops.isCheckHeldByApp('o/r', 'main', name, 999))._unsafeUnwrap()).toBe(true);
  });

  test('not held when nothing protects the branch (404s)', async () => {
    const { ops } = opsFor({});
    expect((await ops.isCheckHeldByApp('o/r', 'main', name, 999))._unsafeUnwrap()).toBe(false);
  });

  test('a GitHub error is an error, not "not held"', async () => {
    const { ops } = opsFor({ 'GET /repos/o/r/rules/branches/main?per_page=100': 500 });
    expect((await ops.isCheckHeldByApp('o/r', 'main', name, 999)).isErr()).toBe(true);
  });
});
