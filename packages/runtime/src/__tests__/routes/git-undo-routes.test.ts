/**
 * Restore routes (track-user-and-scheduled-actions, design D6) against a real
 * temporary repository: a restore puts the snapshot back and is recorded, a
 * pruned snapshot answers 404, a running agent blocks a thread restore.
 */
import { afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { ok } from 'neverthrow';

const mocks = (() => ({
  cwd: '',
  agentRunning: false,
  recorded: [] as Array<{ spec: any; outcome: any }>,
}))();

mock.module('../../routes/git/helpers.js', () => ({
  requireProjectCwd: async () => ok(mocks.cwd),
  gitStatusCache: new Map(),
  invalidateGitStatusCache: async () => undefined,
}));
mock.module('../../utils/route-helpers.js', () => ({
  requireThreadCwd: async () => ok(mocks.cwd),
}));
mock.module('../../services/agent-runner-control.js', () => ({
  isAgentRunning: () => mocks.agentRunning,
}));
mock.module('../../services/thread-manager.js', () => ({
  getThread: async (id: string) => ({ id, projectId: 'p1' }),
}));
// The rest of the tracker stays real: modules loaded with the routes import
// `trackActivity` from it, and a mock without it fails them at link time.
const actualActivityTracker = await import('../../services/activity-tracker.js');
mock.module('../../services/activity-tracker.js', () => ({
  ...actualActivityTracker,
  recordActivity: vi.fn(async (spec: any, outcome: any) => {
    mocks.recorded.push({ spec, outcome });
  }),
}));

const { undoRoutes } = await import('../../routes/git/undo.js');
const { saveUndoSnapshot } = await import('../../services/git-undo.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function app() {
  const a = new Hono<any>();
  a.use('*', async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });
  a.route('/git', undoRoutes);
  return a;
}

beforeEach(async () => {
  mocks.cwd = await mkdtemp(join(tmpdir(), 'funny-undo-route-'));
  mocks.agentRunning = false;
  mocks.recorded.length = 0;
  git(mocks.cwd, 'init');
  git(mocks.cwd, 'config', 'user.name', 'T');
  git(mocks.cwd, 'config', 'user.email', 't@example.com');
  await writeFile(join(mocks.cwd, 'a.txt'), 'initial\n');
  git(mocks.cwd, 'add', 'a.txt');
  git(mocks.cwd, 'commit', '-m', 'initial');
});

afterEach(async () => {
  await rm(mocks.cwd, { recursive: true, force: true });
});

describe('undo routes', () => {
  test('a project restore puts the files back and is recorded with its own snapshot', async () => {
    await writeFile(join(mocks.cwd, 'a.txt'), 'edited\n');
    await saveUndoSnapshot({ cwd: mocks.cwd, activityId: 'd1', kind: 'worktree' });
    git(mocks.cwd, 'checkout', '--', 'a.txt');

    const res = await app().request('/git/project/p1/undo/d1', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await readFile(join(mocks.cwd, 'a.txt'), 'utf8')).toBe('edited\n');
    expect(mocks.recorded).toHaveLength(1);
    expect(mocks.recorded[0]!.spec).toMatchObject({
      kind: 'git.destructive',
      projectId: 'p1',
      input: { action: 'restore' },
    });
    expect(mocks.recorded[0]!.outcome.resultRef.snapshot).toMatch(/^refs\/funny\/undo\//);
  });

  test('a pruned snapshot answers 404 and records nothing', async () => {
    const res = await app().request('/git/project/p1/undo/gone', { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('snapshot-gone');
    expect(mocks.recorded).toHaveLength(0);
  });

  test('a thread restore is refused while its agent runs', async () => {
    await saveUndoSnapshot({ cwd: mocks.cwd, activityId: 'd1', kind: 'worktree' });
    mocks.agentRunning = true;
    const res = await app().request('/git/t1/undo/d1', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  test('a thread restore records the thread', async () => {
    await saveUndoSnapshot({ cwd: mocks.cwd, activityId: 'd1', kind: 'worktree' });
    const res = await app().request('/git/t1/undo/d1', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mocks.recorded[0]!.spec).toMatchObject({ threadId: 't1', projectId: 'p1' });
  });
});
