/**
 * The branch guard on a factory follow-up, against a real worktree: it runs
 * only while the worktree is on the run's branch, so a worktree someone
 * switched to another branch (issue 201's was) never gets the next step.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { checkExpectedBranch } from '../../services/thread-service/expected-branch.js';

describe('checkExpectedBranch', () => {
  let repo: string;
  let worktree: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'expected-branch-test-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email test@example.com', { cwd: repo });
    execSync('git config user.name test', { cwd: repo });
    execSync('git commit -q --allow-empty -m init', { cwd: repo });
    worktree = join(repo, '..', `${repo.split('/').pop()}-wt`);
    execSync(`git worktree add -q -b factory/issue-7-r1 ${worktree}`, { cwd: repo });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test('passes while the worktree is on the expected branch', async () => {
    expect((await checkExpectedBranch(worktree, 'factory/issue-7-r1')).isOk()).toBe(true);
  });

  test('refuses with a conflict naming both branches once it was switched', async () => {
    execSync('git switch -q -c fix/something-else', { cwd: worktree });

    const checked = await checkExpectedBranch(worktree, 'factory/issue-7-r1');

    expect(checked.isErr()).toBe(true);
    const error = checked._unsafeUnwrapErr();
    expect(error.type).toBe('CONFLICT');
    expect(error.message).toContain('"fix/something-else"');
    expect(error.message).toContain('"factory/issue-7-r1"');
  });

  test('refuses a detached worktree', async () => {
    execSync('git switch -q --detach', { cwd: worktree });
    expect((await checkExpectedBranch(worktree, 'factory/issue-7-r1')).isErr()).toBe(true);
  });

  test('checks nothing without an expected branch or a worktree', async () => {
    execSync('git switch -q -c fix/something-else', { cwd: worktree });
    expect((await checkExpectedBranch(worktree, undefined)).isOk()).toBe(true);
    expect((await checkExpectedBranch(null, 'factory/issue-7-r1')).isOk()).toBe(true);
  });
});
