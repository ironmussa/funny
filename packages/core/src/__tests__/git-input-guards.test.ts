/**
 * Defensive input guards inside core git functions (security H5 / M7). The
 * routes validate first; these make sure a caller that forgets cannot read
 * arbitrary files or smuggle options into git.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { getFullContextFileDiff, getSingleFileDiff } from '../git/diff.js';
import { getCommitBody, getCommitFileDiff, getCommitFiles, getLog } from '../git/log.js';
import { isSafeGitRefArg } from '../git/ref-guard.js';
import { getCommittedBranchSummary } from '../git/status.js';

const ROOT = resolve(tmpdir(), 'core-git-input-guards');
const CWD = join(ROOT, 'repo');
const OUTSIDE = join(ROOT, 'outside.txt');

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  writeFileSync(OUTSIDE, 'top secret\n');
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('file diff path guard (H5)', () => {
  for (const fn of [getSingleFileDiff, getFullContextFileDiff]) {
    for (const bad of ['/etc/passwd', OUTSIDE, '../outside.txt', '../../x']) {
      test(`${fn.name} refuses ${bad}`, async () => {
        const result = await fn(CWD, bad, false);
        expect(result.isErr()).toBe(true);
      });
    }
  }
});

describe('git ref guard (M7)', () => {
  const evil = `--output=${join(ROOT, 'pwned')}`;

  test('isSafeGitRefArg', () => {
    expect(isSafeGitRefArg('main')).toBe(true);
    expect(isSafeGitRefArg('origin/feature-x')).toBe(true);
    expect(isSafeGitRefArg('abc123')).toBe(true);
    expect(isSafeGitRefArg('--output=/tmp/x')).toBe(false);
    expect(isSafeGitRefArg('-n')).toBe(false);
    expect(isSafeGitRefArg('a b')).toBe(false);
    expect(isSafeGitRefArg('')).toBe(false);
    expect(isSafeGitRefArg(undefined)).toBe(false);
  });

  test('commit functions refuse option-shaped hashes', async () => {
    expect((await getCommitBody(CWD, evil)).isErr()).toBe(true);
    expect((await getCommitFiles(CWD, evil)).isErr()).toBe(true);
    expect((await getCommitFileDiff(CWD, evil, 'a.ts')).isErr()).toBe(true);
    expect(existsSync(join(ROOT, 'pwned'))).toBe(false);
  });

  test('getLog refuses an option-shaped baseBranch', async () => {
    expect((await getLog(CWD, 10, evil)).isErr()).toBe(true);
  });

  test('getCommittedBranchSummary refuses option-shaped branches', async () => {
    expect((await getCommittedBranchSummary(CWD, evil, 'main')).isErr()).toBe(true);
    expect((await getCommittedBranchSummary(CWD, 'main', evil)).isErr()).toBe(true);
  });
});
