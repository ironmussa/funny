// The git watcher relies on these fingerprints to refresh only the threads
// whose git state moved. Requires @funny/native-git; skipped when it is not
// built (CI builds it for the parity tests).

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { getNativeGit } from '../git/native.js';
import { executeSync } from '../git/process.js';
import { baseBranchRefs, getRefFingerprint } from '../git/ref-fingerprint.js';

const nativeAvailable = getNativeGit() !== null;
const TMP = resolve(tmpdir(), 'core-ref-fingerprint-' + Date.now());
const MAIN = resolve(TMP, 'repo');
const WA = resolve(TMP, 'wa');
const WB = resolve(TMP, 'wb');

function git(cwd: string, ...args: string[]): void {
  executeSync('git', args, { cwd });
}

async function fingerprint(cwd: string): Promise<string> {
  const result = await getRefFingerprint(cwd, baseBranchRefs('master'));
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

test('baseBranchRefs maps a base branch to its local and origin refs', () => {
  expect(baseBranchRefs('master')).toEqual(['refs/heads/master', 'refs/remotes/origin/master']);
  expect(baseBranchRefs('origin/dev')).toEqual(['refs/heads/dev', 'refs/remotes/origin/dev']);
  expect(baseBranchRefs(null)).toEqual([]);
});

describe.skipIf(!nativeAvailable)('getRefFingerprint', () => {
  beforeAll(() => {
    mkdirSync(MAIN, { recursive: true });
    git(MAIN, 'init', '-b', 'master');
    git(MAIN, 'config', 'user.email', 'test@test.com');
    git(MAIN, 'config', 'user.name', 'Test');
    writeFileSync(resolve(MAIN, 'a.txt'), 'a\n');
    git(MAIN, 'add', '-A');
    git(MAIN, 'commit', '-m', 'init');
    git(MAIN, 'worktree', 'add', '-b', 'a', WA);
    git(MAIN, 'worktree', 'add', '-b', 'b', WB);
  });

  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  test('is stable when nothing changed', async () => {
    expect(await fingerprint(WA)).toBe(await fingerprint(WA));
  });

  test('a commit in one worktree changes only that worktree', async () => {
    const a0 = await fingerprint(WA);
    const b0 = await fingerprint(WB);
    git(WA, 'commit', '--allow-empty', '-m', 'on a');
    expect(await fingerprint(WA)).not.toBe(a0);
    expect(await fingerprint(WB)).toBe(b0);
  });

  test('moving the base branch changes every worktree based on it', async () => {
    const a0 = await fingerprint(WA);
    const b0 = await fingerprint(WB);
    git(MAIN, 'commit', '--allow-empty', '-m', 'on master');
    expect(await fingerprint(WA)).not.toBe(a0);
    expect(await fingerprint(WB)).not.toBe(b0);
  });

  test('creating the remote branch changes the fingerprint', async () => {
    const b0 = await fingerprint(WB);
    git(MAIN, 'update-ref', 'refs/remotes/origin/b', 'HEAD');
    expect(await fingerprint(WB)).not.toBe(b0);
  });

  test('staging changes the fingerprint', async () => {
    const a0 = await fingerprint(WA);
    writeFileSync(resolve(WA, 'new.txt'), 'new\n');
    git(WA, 'add', 'new.txt');
    expect(await fingerprint(WA)).not.toBe(a0);
  });
});
