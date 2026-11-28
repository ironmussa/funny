import { describe, expect, test, vi } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { okAsync } from 'neverthrow';

import {
  commitAndPushSetup,
  pushSetupBranchAndOpenPR,
  sha256Hex,
} from '../../services/factory-flow-setup-git.js';

interface FixtureRepo {
  root: string;
  bareDir: string;
  cloneDir: string;
  worktreeDir: string;
  cleanup: () => void;
}

function makeGitFixture(): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), 'funny-setup-git-'));
  const bareDir = join(root, 'remote.git');
  const cloneDir = join(root, 'clone');
  const worktreeDir = join(root, 'setup-wt');

  execFileSync('git', ['init', '--bare', '-b', 'main', bareDir]);
  execFileSync('git', ['clone', bareDir, cloneDir]);
  execFileSync('git', ['config', 'user.email', 'member@example.com'], { cwd: cloneDir });
  execFileSync('git', ['config', 'user.name', 'Member'], { cwd: cloneDir });

  writeFileSync(join(cloneDir, 'README.md'), '# Repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: cloneDir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: cloneDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: cloneDir });

  execFileSync(
    'git',
    ['worktree', 'add', '-b', 'funny/factory-setup/s1', worktreeDir, 'origin/main'],
    { cwd: cloneDir },
  );
  execFileSync('git', ['config', 'user.email', 'member@example.com'], { cwd: worktreeDir });
  execFileSync('git', ['config', 'user.name', 'Member'], { cwd: worktreeDir });

  return {
    root,
    bareDir,
    cloneDir,
    worktreeDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const FLOW_CONTENT = `name: issue-to-merge\nsteps:\n  - name: merge\n    type: merge\n`;
const PROMPT_CONTENT = `# Implement prompt\n`;

describe('commitAndPushSetup', () => {
  test('commits ONLY setup files, ignores unrelated agent edits/canaries, and pushes to default branch', async () => {
    const fx = makeGitFixture();
    try {
      // Simulate dirty agent edits and canary files left in the worktree.
      writeFileSync(join(fx.worktreeDir, 'README.md'), 'dirty agent edit\n');
      writeFileSync(join(fx.worktreeDir, 'canary.spec.ts'), '// canary\n');

      const res = await commitAndPushSetup({
        worktreePath: fx.worktreeDir,
        defaultBranch: 'main',
        files: [
          { path: '.funny/workflows/issue-to-merge.yaml', content: FLOW_CONTENT },
          { path: '.funny/workflows/prompts/implement.md', content: PROMPT_CONTENT },
        ],
        expectedFlowSha: sha256Hex(FLOW_CONTENT),
        commitMessage: 'chore(factory): configure regression proof',
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/);

      // Verify remote main has the commit with ONLY the two setup files.
      const filesInCommit = execFileSync(
        'git',
        ['--git-dir', fx.bareDir, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main'],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .sort();
      expect(filesInCommit).toEqual([
        '.funny/workflows/issue-to-merge.yaml',
        '.funny/workflows/prompts/implement.md',
      ]);
    } finally {
      fx.cleanup();
    }
  });

  test('rebases once and succeeds when the remote default branch moved cleanly', async () => {
    const fx = makeGitFixture();
    try {
      // Push another commit to remote main from the main clone.
      writeFileSync(join(fx.cloneDir, 'OTHER.md'), 'other change\n');
      execFileSync('git', ['add', 'OTHER.md'], { cwd: fx.cloneDir });
      execFileSync('git', ['commit', '-m', 'remote advance'], { cwd: fx.cloneDir });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: fx.cloneDir });

      const res = await commitAndPushSetup({
        worktreePath: fx.worktreeDir,
        defaultBranch: 'main',
        files: [{ path: '.funny/workflows/issue-to-merge.yaml', content: FLOW_CONTENT }],
        expectedFlowSha: sha256Hex(FLOW_CONTENT),
        commitMessage: 'chore(factory): configure regression proof',
      });

      expect(res.ok).toBe(true);
      const log = execFileSync('git', ['--git-dir', fx.bareDir, 'log', '--format=%s', 'main'], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n');
      expect(log[0]).toBe('chore(factory): configure regression proof');
      expect(log[1]).toBe('remote advance');
    } finally {
      fx.cleanup();
    }
  });

  test('returns conflict and aborts rebase when remote edited the same flow file', async () => {
    const fx = makeGitFixture();
    try {
      mkdirSync(join(fx.cloneDir, '.funny/workflows'), { recursive: true });
      writeFileSync(
        join(fx.cloneDir, '.funny/workflows/issue-to-merge.yaml'),
        'name: conflicting\nsteps: []\n',
      );
      execFileSync('git', ['add', '.funny/workflows/issue-to-merge.yaml'], { cwd: fx.cloneDir });
      execFileSync('git', ['commit', '-m', 'conflicting workflow'], { cwd: fx.cloneDir });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: fx.cloneDir });

      const res = await commitAndPushSetup({
        worktreePath: fx.worktreeDir,
        defaultBranch: 'main',
        files: [{ path: '.funny/workflows/issue-to-merge.yaml', content: FLOW_CONTENT }],
        expectedFlowSha: sha256Hex(FLOW_CONTENT),
        commitMessage: 'chore(factory): configure regression proof',
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.kind).toBe('conflict');
    } finally {
      fx.cleanup();
    }
  });

  test('classifies pre-receive hook / branch protection rejection and preserves remote message', async () => {
    const fx = makeGitFixture();
    try {
      const hookPath = join(fx.bareDir, 'hooks/pre-receive');
      writeFileSync(
        hookPath,
        '#!/bin/sh\necho "error: GH006: Protected branch update failed for refs/heads/main." >&2\necho "Changes must be made through a pull request." >&2\nexit 1\n',
      );
      chmodSync(hookPath, 0o755);

      const res = await commitAndPushSetup({
        worktreePath: fx.worktreeDir,
        defaultBranch: 'main',
        files: [{ path: '.funny/workflows/issue-to-merge.yaml', content: FLOW_CONTENT }],
        expectedFlowSha: sha256Hex(FLOW_CONTENT),
        commitMessage: 'chore(factory): configure regression proof',
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.kind).toBe('branch-rule-rejected');
      expect(res.message).toContain('GH006');
      expect(res.message).toContain('pull request');
    } finally {
      fx.cleanup();
    }
  });

  test('refuses sha mismatch and paths outside .funny/', async () => {
    const fx = makeGitFixture();
    try {
      const shaErr = await commitAndPushSetup({
        worktreePath: fx.worktreeDir,
        defaultBranch: 'main',
        files: [{ path: '.funny/workflows/issue-to-merge.yaml', content: FLOW_CONTENT }],
        expectedFlowSha: '0'.repeat(64),
        commitMessage: 'chore: test',
      });
      expect(shaErr.ok).toBe(false);
      if (!shaErr.ok) expect(shaErr.kind).toBe('sha-mismatch');

      const pathErr = await commitAndPushSetup({
        worktreePath: fx.worktreeDir,
        defaultBranch: 'main',
        files: [{ path: 'package.json', content: '{}' }],
        expectedFlowSha: sha256Hex('{}'),
        commitMessage: 'chore: test',
      });
      expect(pathErr.ok).toBe(false);
      if (!pathErr.ok) expect(pathErr.kind).toBe('invalid-path');
    } finally {
      fx.cleanup();
    }
  });
});

describe('pushSetupBranchAndOpenPR', () => {
  test('pushes the setup branch and calls createPullRequest with the member token', async () => {
    const fx = makeGitFixture();
    try {
      // Create a setup commit on the setup branch first.
      mkdirSync(join(fx.worktreeDir, '.funny/workflows'), { recursive: true });
      writeFileSync(join(fx.worktreeDir, '.funny/workflows/issue-to-merge.yaml'), FLOW_CONTENT);
      execFileSync('git', ['add', '.funny/workflows/issue-to-merge.yaml'], { cwd: fx.worktreeDir });
      execFileSync('git', ['commit', '-m', 'chore(factory): setup'], { cwd: fx.worktreeDir });

      const fakeCreatePR = vi.fn(() =>
        okAsync({ prUrl: 'https://github.com/acme/repo/pull/42', prNumber: 42 }),
      );

      const res = await pushSetupBranchAndOpenPR(
        {
          worktreePath: fx.worktreeDir,
          setupBranch: 'funny/factory-setup/s1',
          defaultBranch: 'main',
          title: 'Configure factory regression proof',
          body: 'Proposal summary',
          githubToken: 'ghp_member_token',
        },
        { createPullRequest: fakeCreatePR },
      );

      expect(res).toEqual({
        ok: true,
        prUrl: 'https://github.com/acme/repo/pull/42',
        prNumber: 42,
      });

      // Verify the setup branch was pushed to the bare remote.
      const refs = execFileSync(
        'git',
        ['--git-dir', fx.bareDir, 'show-ref', '--heads', 'funny/factory-setup/s1'],
        { encoding: 'utf8' },
      );
      expect(refs).toContain('refs/heads/funny/factory-setup/s1');

      expect(fakeCreatePR).toHaveBeenCalledWith(fx.worktreeDir, {
        title: 'Configure factory regression proof',
        body: 'Proposal summary',
        baseBranch: 'main',
        headBranch: 'funny/factory-setup/s1',
        githubToken: 'ghp_member_token',
      });
    } finally {
      fx.cleanup();
    }
  });
});
