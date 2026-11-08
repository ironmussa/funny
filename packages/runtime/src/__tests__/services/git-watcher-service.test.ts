// End-to-end: a commit in one worktree must refresh only the thread on that
// worktree, not every thread in the project. Needs @funny/native-git (gitoxide)
// to compute fingerprints; skipped when it is not built.

import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { getNativeGit } from '@funny/core/git';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { startWatching, stopWatching } from '../../services/git-watcher-service.js';
import type { RuntimeServiceProvider } from '../../services/service-provider.js';
import { resetServices, setServices } from '../../services/service-registry.js';
import { threadEventBus } from '../../services/thread-event-bus.js';

const nativeAvailable = getNativeGit() !== null;
const TMP = resolve(tmpdir(), 'runtime-git-watcher-' + Date.now());
const MAIN = resolve(TMP, 'repo');
const WA = resolve(TMP, 'wa');
const WB = resolve(TMP, 'wb');
const PROJECT = 'p-watch';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Thread ids that received `git:changed` while `action` ran (plus settle time). */
async function changedDuring(action: () => void): Promise<string[]> {
  const seen = new Set<string>();
  const listener = (event: { threadId: string }) => seen.add(event.threadId);
  threadEventBus.on('git:changed', listener);
  try {
    action();
    await new Promise((r) => setTimeout(r, 1200));
  } finally {
    threadEventBus.off('git:changed', listener);
  }
  return [...seen].sort();
}

describe.skipIf(!nativeAvailable)('git watcher fingerprint filtering', () => {
  beforeAll(() => {
    mkdirSync(MAIN, { recursive: true });
    git(MAIN, 'init', '-b', 'master');
    git(MAIN, 'config', 'user.email', 'test@test.com');
    git(MAIN, 'config', 'user.name', 'Test');
    git(MAIN, 'commit', '--allow-empty', '-m', 'init');
    git(MAIN, 'worktree', 'add', '-b', 'a', WA);
    git(MAIN, 'worktree', 'add', '-b', 'b', WB);

    resetServices();
    setServices({
      threads: { getThread: async () => ({ baseBranch: 'master' }) },
    } as unknown as RuntimeServiceProvider);

    startWatching(PROJECT, MAIN, 'thread-a', 'u1', WA);
    startWatching(PROJECT, MAIN, 'thread-b', 'u1', WB);
  });

  afterAll(() => {
    stopWatching(PROJECT, 'thread-a');
    stopWatching(PROJECT, 'thread-b');
    resetServices();
    rmSync(TMP, { recursive: true, force: true });
  });

  test('a commit in one worktree notifies only its thread', async () => {
    // The first change seeds the fingerprints and notifies every thread.
    expect(await changedDuring(() => git(MAIN, 'update-ref', 'refs/tags/seed', 'HEAD'))).toEqual([
      'thread-a',
      'thread-b',
    ]);

    expect(await changedDuring(() => git(WA, 'commit', '--allow-empty', '-m', 'on a'))).toEqual([
      'thread-a',
    ]);
  });

  test('moving the base branch notifies every thread based on it', async () => {
    expect(
      await changedDuring(() => git(MAIN, 'commit', '--allow-empty', '-m', 'on master')),
    ).toEqual(['thread-a', 'thread-b']);
  });
});
