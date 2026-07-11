import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  captureCodexCheckpoint,
  restoreCodexCheckpoint,
} from '../../services/codex-git-checkpoints.js';

const repos: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function createRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'funny-codex-checkpoints-test-'));
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

describe('Codex Git checkpoints', () => {
  test('restores the pre-turn worktree while preserving its original index state', async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, 'tracked.txt'), 'before turn\n');
    await writeFile(join(cwd, 'untracked-before.txt'), 'keep me\n');
    await writeFile(join(cwd, 'staged-before.txt'), 'staged\n');
    git(cwd, 'add', 'staged-before.txt');

    await captureCodexCheckpoint({ threadId: 'thread_1', messageId: 'message_1', cwd });

    await writeFile(join(cwd, 'tracked.txt'), 'after turn\n');
    await writeFile(join(cwd, 'untracked-before.txt'), 'changed after turn\n');
    await writeFile(join(cwd, 'untracked-after.txt'), 'remove me\n');
    git(cwd, 'add', 'tracked.txt');

    const result = await restoreCodexCheckpoint({
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

    const result = await restoreCodexCheckpoint({
      threadId: 'thread_1',
      messageId: 'missing',
      cwd,
    });

    expect(result).toMatchObject({ canRewind: false, filesChanged: [] });
    await expect(readFile(join(cwd, 'tracked.txt'), 'utf8')).resolves.toBe('unchanged\n');
  });
});
