/**
 * Undo snapshots (track-user-and-scheduled-actions, design D4–D5) against a
 * real temporary repository.
 */
import { afterEach, describe, expect, test, vi } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { internal } from '@funny/shared/errors';
import { err, ok } from 'neverthrow';

import {
  pruneUndoSnapshots,
  restoreUndoSnapshot,
  runDestructive,
  saveUndoSnapshot,
} from '../../services/git-undo.js';

const repos: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function createRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'funny-undo-test-'));
  repos.push(cwd);
  git(cwd, 'init');
  git(cwd, 'config', 'user.name', 'Funny Tests');
  git(cwd, 'config', 'user.email', 'tests@example.com');
  await writeFile(join(cwd, 'tracked.txt'), 'initial\n');
  git(cwd, 'add', 'tracked.txt');
  git(cwd, 'commit', '-m', 'initial');
  return cwd;
}

const read = (cwd: string, file: string) => readFile(join(cwd, file), 'utf8');

afterEach(async () => {
  await Promise.all(repos.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

describe('undo snapshots', () => {
  test('tracked, staged and untracked changes come back after a discard', async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, 'tracked.txt'), 'edited\n');
    await writeFile(join(cwd, 'staged.txt'), 'staged\n');
    git(cwd, 'add', 'staged.txt');
    await writeFile(join(cwd, 'untracked.txt'), 'new\n');

    const saved = await saveUndoSnapshot({ cwd, activityId: 'a1', kind: 'worktree' });
    expect(saved._unsafeUnwrap().ref).toBe('refs/funny/undo/a1');

    // The discard: everything back to HEAD, untracked files gone.
    git(cwd, 'reset', '--hard');
    git(cwd, 'clean', '-fd');
    expect(existsSync(join(cwd, 'untracked.txt'))).toBe(false);

    const restored = await restoreUndoSnapshot({ cwd, activityId: 'a1', restoreActivityId: 'r1' });
    expect(restored._unsafeUnwrap()).toEqual({ ref: 'refs/funny/undo/r1', kind: 'worktree' });
    expect(await read(cwd, 'tracked.txt')).toBe('edited\n');
    expect(await read(cwd, 'untracked.txt')).toBe('new\n');
    // Staging is as it was: only staged.txt is in the index.
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('staged.txt');
  });

  test('HEAD comes back after a reset hard', async () => {
    const cwd = await createRepo();
    const first = git(cwd, 'rev-parse', 'HEAD');
    await writeFile(join(cwd, 'tracked.txt'), 'second\n');
    git(cwd, 'commit', '-am', 'second');
    const second = git(cwd, 'rev-parse', 'HEAD');
    await writeFile(join(cwd, 'tracked.txt'), 'uncommitted\n');

    await saveUndoSnapshot({ cwd, activityId: 'a1', kind: 'worktree' });
    git(cwd, 'reset', '--hard', first);

    await restoreUndoSnapshot({ cwd, activityId: 'a1', restoreActivityId: 'r1' });
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(second);
    expect(await read(cwd, 'tracked.txt')).toBe('uncommitted\n');
  });

  test('a dropped stash comes back into the stash list', async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, 'tracked.txt'), 'stashed work\n');
    git(cwd, 'stash', 'push', '-m', 'my work');
    const sha = git(cwd, 'rev-parse', 'stash@{0}');

    await saveUndoSnapshot({ cwd, activityId: 'a1', kind: 'stash', stashRef: 'stash@{0}' });
    git(cwd, 'stash', 'drop', 'stash@{0}');
    expect(git(cwd, 'stash', 'list')).toBe('');

    const restored = await restoreUndoSnapshot({ cwd, activityId: 'a1', restoreActivityId: 'r1' });
    expect(restored._unsafeUnwrap().kind).toBe('stash');
    expect(git(cwd, 'rev-parse', 'stash@{0}')).toBe(sha);
  });

  test('a restore saves the current state first, so it can be undone', async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, 'tracked.txt'), 'before discard\n');
    await saveUndoSnapshot({ cwd, activityId: 'a1', kind: 'worktree' });
    await writeFile(join(cwd, 'tracked.txt'), 'newer edit\n');

    await restoreUndoSnapshot({ cwd, activityId: 'a1', restoreActivityId: 'r1' });
    expect(await read(cwd, 'tracked.txt')).toBe('before discard\n');

    await restoreUndoSnapshot({ cwd, activityId: 'r1', restoreActivityId: 'r2' });
    expect(await read(cwd, 'tracked.txt')).toBe('newer edit\n');
  });

  test('a missing snapshot is snapshot-gone', async () => {
    const cwd = await createRepo();
    const result = await restoreUndoSnapshot({ cwd, activityId: 'nope', restoreActivityId: 'r1' });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'NOT_FOUND',
      message: 'snapshot-gone',
    });
  });

  test('an id that could not be a ref name is refused', async () => {
    const cwd = await createRepo();
    const result = await saveUndoSnapshot({ cwd, activityId: '../heads/main', kind: 'worktree' });
    expect(result.isErr()).toBe(true);
    expect(git(cwd, 'for-each-ref', 'refs/funny')).toBe('');
  });

  test('snapshots older than 30 days are pruned with their index ref', async () => {
    const cwd = await createRepo();
    await saveUndoSnapshot({ cwd, activityId: 'old', kind: 'worktree' });
    const in31Days = () => Date.now() + 31 * 24 * 60 * 60_000;
    expect((await pruneUndoSnapshots(cwd, undefined, in31Days))._unsafeUnwrap()).toBe(1);
    expect(git(cwd, 'for-each-ref', 'refs/funny/undo')).toBe('');
  });

  test('a recent snapshot is kept', async () => {
    const cwd = await createRepo();
    await saveUndoSnapshot({ cwd, activityId: 'new', kind: 'worktree' });
    expect((await pruneUndoSnapshots(cwd))._unsafeUnwrap()).toBe(0);
  });
});

describe('runDestructive', () => {
  const spec = {
    userId: 'u1',
    projectId: 'p1',
    title: 'Discard changes to 1 file',
    input: { action: 'discard' as const, paths: ['tracked.txt'] },
  };

  test('snapshot, command, one finished activity naming the snapshot', async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, 'tracked.txt'), 'edited\n');
    const recordActivity = vi.fn(async (_spec: unknown, _outcome: unknown) => undefined);
    const result = await runDestructive(
      {
        spec,
        cwd,
        snapshot: { kind: 'worktree' },
        run: async () => {
          git(cwd, 'checkout', '--', 'tracked.txt');
          return ok(undefined);
        },
        effectsOf: () => [{ effect: 'changes-discarded', target: 'tracked.txt' }],
      },
      { recordActivity, newId: () => 'd1' },
    );
    expect(result.isOk()).toBe(true);
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd1', kind: 'git.destructive', origin: 'user' }),
      {
        ok: true,
        effects: [
          { effect: 'changes-discarded', target: 'tracked.txt' },
          { effect: 'snapshot-saved', target: 'refs/funny/undo/d1' },
        ],
        resultRef: { snapshot: 'refs/funny/undo/d1' },
      },
    );
  });

  test('a failed command is recorded failed and keeps its snapshot', async () => {
    const cwd = await createRepo();
    const recordActivity = vi.fn(async (_spec: unknown, _outcome: unknown) => undefined);
    const result = await runDestructive(
      {
        spec,
        cwd,
        snapshot: { kind: 'worktree' },
        run: async () => err(internal('git refused')),
        effectsOf: () => [],
      },
      { recordActivity, newId: () => 'd2' },
    );
    expect(result.isErr()).toBe(true);
    expect(recordActivity.mock.calls[0]![1]).toMatchObject({ ok: false, error: 'git refused' });
    expect(git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/funny/undo/d2')).toBe(
      'refs/funny/undo/d2',
    );
  });

  test('when the snapshot fails the command does not run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'funny-undo-not-a-repo-'));
    repos.push(cwd);
    const run = vi.fn(async () => ok(undefined));
    const recordActivity = vi.fn(async (_spec: unknown, _outcome: unknown) => undefined);
    const result = await runDestructive(
      { spec, cwd, snapshot: { kind: 'worktree' }, run, effectsOf: () => [] },
      { recordActivity, newId: () => 'd3' },
    );
    expect(result.isErr()).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(recordActivity.mock.calls[0]![1]).toMatchObject({ ok: false });
  });
});
