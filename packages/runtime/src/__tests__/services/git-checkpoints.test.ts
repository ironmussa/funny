import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureGitCheckpoint,
  copyGitCheckpoint,
  pruneGitCheckpoints,
  removeThreadCheckpoints,
  restoreGitCheckpoint,
} from '../../services/git-checkpoints.js';

const repos: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function createRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'funny-checkpoints-test-'));
  repos.push(cwd);
  git(cwd, 'init');
  git(cwd, 'config', 'user.name', 'Funny Tests');
  git(cwd, 'config', 'user.email', 'tests@example.com');
  await writeFile(join(cwd, 'tracked.txt'), 'initial\n');
  git(cwd, 'add', 'tracked.txt');
  git(cwd, 'commit', '-m', 'initial');
  return cwd;
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

describe('Git checkpoints', () => {
  test('restores the pre-turn worktree while preserving its original index state', async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, 'tracked.txt'), 'before turn\n');
    await writeFile(join(cwd, 'untracked-before.txt'), 'keep me\n');
    await writeFile(join(cwd, 'staged-before.txt'), 'staged\n');
    git(cwd, 'add', 'staged-before.txt');

    await captureGitCheckpoint({ threadId: 'thread_1', messageId: 'message_1', cwd });

    await writeFile(join(cwd, 'tracked.txt'), 'after turn\n');
    await writeFile(join(cwd, 'untracked-before.txt'), 'changed after turn\n');
    await writeFile(join(cwd, 'untracked-after.txt'), 'remove me\n');
    git(cwd, 'add', 'tracked.txt');

    const result = await restoreGitCheckpoint({
      threadId: 'thread_1',
      messageId: 'message_1',
      cwd,
    });

    expect(result.canRewind).toBe(true);
    await expect(readFile(join(cwd, 'tracked.txt'), 'utf8')).resolves.toBe('before turn\n');
    await expect(readFile(join(cwd, 'untracked-before.txt'), 'utf8')).resolves.toBe('keep me\n');
    await expect(readFile(join(cwd, 'untracked-after.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('staged-before.txt\n');
  });

  test('reports an unavailable checkpoint without changing files', async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, 'tracked.txt'), 'unchanged\n');

    const result = await restoreGitCheckpoint({
      threadId: 'thread_1',
      messageId: 'missing',
      cwd,
    });

    expect(result).toMatchObject({ canRewind: false, filesChanged: [] });
    await expect(readFile(join(cwd, 'tracked.txt'), 'utf8')).resolves.toBe('unchanged\n');
  });

  test('copies a checkpoint to another thread message', async () => {
    const cwd = await createRepo();
    await captureGitCheckpoint({ threadId: 'thread_1', messageId: 'message_1', cwd });
    await writeFile(join(cwd, 'tracked.txt'), 'changed\n');

    const copied = await copyGitCheckpoint({
      cwd,
      from: { threadId: 'thread_1', messageId: 'message_1' },
      to: { threadId: 'fork_1', messageId: 'message_9' },
    });
    const result = await restoreGitCheckpoint({
      threadId: 'fork_1',
      messageId: 'message_9',
      cwd,
    });

    expect(copied).toBe(true);
    expect(result.canRewind).toBe(true);
    expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('initial\n');
  });

  test('does not copy a checkpoint that does not exist', async () => {
    const cwd = await createRepo();

    const copied = await copyGitCheckpoint({
      cwd,
      from: { threadId: 'thread_1', messageId: 'missing' },
      to: { threadId: 'fork_1', messageId: 'message_9' },
    });

    expect(copied).toBe(false);
  });
});

describe('dated checkpoints (track-pipeline-runs)', () => {
  const ref = (thread: string, message: string, kind: string) =>
    `refs/funny/codex-checkpoints/${thread}/${message}/${kind}`;
  const refs = (cwd: string) =>
    git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/funny/codex-checkpoints').trim();

  test('a new checkpoint is a dated commit and still restores', async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, 'tracked.txt'), 'before\n');
    await captureGitCheckpoint({ threadId: 't1', messageId: 'm1', cwd });
    expect(git(cwd, 'cat-file', '-t', ref('t1', 'm1', 'worktree')).trim()).toBe('commit');

    await writeFile(join(cwd, 'tracked.txt'), 'after\n');
    const restored = await restoreGitCheckpoint({ threadId: 't1', messageId: 'm1', cwd });
    expect(restored.canRewind).toBe(true);
    expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('before\n');
  });

  test('a legacy checkpoint (a bare tree) still restores and is kept by the age prune', async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, 'tracked.txt'), 'legacy\n');
    git(cwd, 'add', '-A');
    const tree = git(cwd, 'write-tree').trim();
    git(cwd, 'update-ref', ref('t0', 'm0', 'worktree'), tree);
    git(cwd, 'update-ref', ref('t0', 'm0', 'index'), tree);
    await writeFile(join(cwd, 'tracked.txt'), 'later\n');

    const restored = await restoreGitCheckpoint({ threadId: 't0', messageId: 'm0', cwd });
    expect(restored.canRewind).toBe(true);
    expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('legacy\n');

    const in31Days = () => Date.now() + 31 * 24 * 60 * 60_000;
    expect(await pruneGitCheckpoints(cwd, undefined, in31Days)).toBe(0);
    expect(refs(cwd)).toContain(ref('t0', 'm0', 'worktree'));
  });

  test('a checkpoint older than 30 days is pruned with its index ref; a recent one stays', async () => {
    const cwd = await createRepo();
    await captureGitCheckpoint({ threadId: 't1', messageId: 'm1', cwd });
    expect(await pruneGitCheckpoints(cwd)).toBe(0);

    const in31Days = () => Date.now() + 31 * 24 * 60 * 60_000;
    expect(await pruneGitCheckpoints(cwd, undefined, in31Days)).toBe(1);
    expect(refs(cwd)).toBe('');
  });

  test("removing a thread's checkpoints leaves the other threads' alone", async () => {
    const cwd = await createRepo();
    await captureGitCheckpoint({ threadId: 't1', messageId: 'm1', cwd });
    await captureGitCheckpoint({ threadId: 't1', messageId: 'm2', cwd });
    await captureGitCheckpoint({ threadId: 't2', messageId: 'm1', cwd });

    expect(await removeThreadCheckpoints(cwd, 't1')).toBe(4);
    expect(refs(cwd).split('\n')).toEqual([ref('t2', 'm1', 'index'), ref('t2', 'm1', 'worktree')]);
  });
});
