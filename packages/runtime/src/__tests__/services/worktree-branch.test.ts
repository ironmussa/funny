/**
 * The branch a new worktree thread is created on: the caller's (the issue
 * factory's run branch) when it is free, reused when it exists and no
 * worktree holds it (a retried run), else the generated one so the thread
 * still starts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createWorktree } from '@funny/core/git';

import { worktreeBranchName } from '../../services/thread-service/worktree-branch.js';

describe('worktreeBranchName', () => {
  let repo: string;
  let other: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'worktree-branch-test-'));
    other = mkdtempSync(join(tmpdir(), 'worktree-branch-other-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email test@example.com', { cwd: repo });
    execSync('git config user.name test', { cwd: repo });
    execSync('git commit -q --allow-empty -m init', { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  test('uses the requested branch when it does not exist yet', async () => {
    expect(await worktreeBranchName(repo, 'factory/issue-7-r1', 'proj/generated-abc')).toEqual({
      name: 'factory/issue-7-r1',
      reuse: false,
    });
  });

  test('reuses the requested branch when it exists and no worktree holds it', async () => {
    execSync('git branch factory/issue-7-r1', { cwd: repo });
    expect(await worktreeBranchName(repo, 'factory/issue-7-r1', 'proj/generated-abc')).toEqual({
      name: 'factory/issue-7-r1',
      reuse: true,
    });
  });

  test('falls back to the generated name when another worktree has the branch, and says which', async () => {
    execSync(`git worktree add -q -b factory/issue-7-r1 ${join(other, 'wt')}`, { cwd: repo });
    const branch = await worktreeBranchName(repo, 'factory/issue-7-r1', 'proj/generated-abc');
    expect(branch).toMatchObject({ name: 'proj/generated-abc', reuse: false });
    // A caller that requires its branch (the issue factory) refuses with this path.
    expect(branch.heldBy).toContain('wt');
  });

  test('uses the generated name when no branch is requested', async () => {
    const generated = { name: 'proj/generated-abc', reuse: false };
    expect(await worktreeBranchName(repo, undefined, 'proj/generated-abc')).toEqual(generated);
    expect(await worktreeBranchName(repo, '  ', 'proj/generated-abc')).toEqual(generated);
  });

  // A retried factory run: its earlier attempt's commit is on the branch.
  test("a reused branch's worktree starts from that branch's commits", async () => {
    execSync('git switch -q -c factory/issue-7-r1', { cwd: repo });
    execSync('git commit -q --allow-empty -m "first attempt"', { cwd: repo });
    execSync('git switch -q -', { cwd: repo });

    const branch = await worktreeBranchName(repo, 'factory/issue-7-r1', 'proj/generated-abc');
    const created = await createWorktree(repo, branch.name, undefined, undefined, {
      reuseExistingBranch: branch.reuse,
    });

    expect(created.isOk()).toBe(true);
    const path = created._unsafeUnwrap();
    expect(execSync('git log -1 --format=%s', { cwd: path }).toString().trim()).toBe(
      'first attempt',
    );
    expect(execSync('git branch --show-current', { cwd: path }).toString().trim()).toBe(
      'factory/issue-7-r1',
    );
    execSync(`git worktree remove --force ${path}`, { cwd: repo });
  });
});
