/**
 * POST /api/projects/:id/checkout with strategy `stash` against a real
 * repository (track-funny-actions review, track-user-and-scheduled-actions
 * D8): only a stash this request created is popped or recorded.
 */
import { afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { ok } from 'neverthrow';

const mocks = (() => ({
  path: '',
  recordCheckoutSwitch: vi.fn(async (_change: unknown) => undefined),
}))();

mock.module('../../utils/route-helpers.js', () => ({
  requireProject: async () => ok({ id: 'p1', path: mocks.path, name: 'repo' }),
}));
mock.module('../../services/checkout-activity.js', () => ({
  recordCheckoutSwitch: mocks.recordCheckoutSwitch,
}));
mock.module('../../services/thread-manager.js', () => ({ updateThread: vi.fn() }));
mock.module('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));

const { projectGitRoutes } = await import('../../routes/projects/git-routes.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function app() {
  const a = new Hono<any>();
  a.use('*', async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });
  a.route('/projects', projectGitRoutes);
  return a;
}

const checkout = (branch: string) =>
  app().request('/projects/p1/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch, strategy: 'stash' }),
  });

beforeEach(async () => {
  mocks.path = await mkdtemp(join(tmpdir(), 'funny-checkout-stash-'));
  mocks.recordCheckoutSwitch.mockClear();
  git(mocks.path, 'init', '-b', 'main');
  git(mocks.path, 'config', 'user.name', 'T');
  git(mocks.path, 'config', 'user.email', 't@example.com');
  await writeFile(join(mocks.path, 'a.txt'), 'initial\n');
  git(mocks.path, 'add', 'a.txt');
  git(mocks.path, 'commit', '-m', 'initial');
  git(mocks.path, 'branch', 'develop');
});

afterEach(async () => {
  await rm(mocks.path, { recursive: true, force: true });
});

describe('checkout with strategy stash', () => {
  test('a clean tree with an older stash: a failed checkout pops nothing and records nothing', async () => {
    await writeFile(join(mocks.path, 'a.txt'), 'older work\n');
    git(mocks.path, 'stash', 'push', '-m', 'older');
    const older = git(mocks.path, 'rev-parse', 'stash@{0}');

    const res = await checkout('does-not-exist');

    expect(res.status).toBe(500);
    // The user's older stash is still there and was not applied.
    expect(git(mocks.path, 'rev-parse', 'stash@{0}')).toBe(older);
    expect(await readFile(join(mocks.path, 'a.txt'), 'utf8')).toBe('initial\n');
    expect(mocks.recordCheckoutSwitch).not.toHaveBeenCalled();
  });

  test('a clean tree records no stash on a successful checkout', async () => {
    const res = await checkout('develop');
    expect(res.status).toBe(200);
    expect(mocks.recordCheckoutSwitch).not.toHaveBeenCalled();
  });

  test('a dirty tree is stashed and the switch is recorded with the stash', async () => {
    await writeFile(join(mocks.path, 'a.txt'), 'work in progress\n');

    const res = await checkout('develop');

    expect(res.status).toBe(200);
    expect(git(mocks.path, 'branch', '--show-current')).toBe('develop');
    expect(mocks.recordCheckoutSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ fromBranch: 'main', toBranch: 'develop', stashed: true }),
    );
  });
});
