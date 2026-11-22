/**
 * The branch a new worktree thread is created on: the caller's (the issue
 * factory's run branch) when it is free, so the thread and the pull request
 * share one branch, else the generated one so the thread still starts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { worktreeBranchName } from '../../services/thread-service/worktree-branch.js';

describe('worktreeBranchName', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'worktree-branch-test-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email test@example.com', { cwd: repo });
    execSync('git config user.name test', { cwd: repo });
    execSync('git commit -q --allow-empty -m init', { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('uses the requested branch when it does not exist yet', async () => {
    expect(await worktreeBranchName(repo, 'factory/issue-7-r1', 'proj/generated-abc')).toBe(
      'factory/issue-7-r1',
    );
  });

  test('falls back to the generated name when the requested branch already exists', async () => {
    execSync('git branch factory/issue-7-r1', { cwd: repo });
    expect(await worktreeBranchName(repo, 'factory/issue-7-r1', 'proj/generated-abc')).toBe(
      'proj/generated-abc',
    );
  });

  test('uses the generated name when no branch is requested', async () => {
    expect(await worktreeBranchName(repo, undefined, 'proj/generated-abc')).toBe(
      'proj/generated-abc',
    );
    expect(await worktreeBranchName(repo, '  ', 'proj/generated-abc')).toBe('proj/generated-abc');
  });
});
