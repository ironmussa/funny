/**
 * cleanup — Hatchet workflow for stale branch and worktree cleanup.
 *
 * Two parallel tasks:
 *   1. Clean stale branches (older than config threshold)
 *   2. Clean orphan worktrees (worktrees with no matching branch)
 *
 * Can be triggered on a schedule or manually via API.
 */

import type { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import { execute } from '@funny/core/git';
import { logger } from '../../infrastructure/logger.js';

// ── Input/Output types ──────────────────────────────────────────

interface CleanupInput {
  projectPath: string;
  staleBranchDays?: number;
  dryRun?: boolean;
}

interface CleanBranchesOutput {
  deleted: string[];
  skipped: string[];
}

interface CleanWorktreesOutput {
  removed: string[];
  errors: string[];
}

type WorkflowOutput = {
  'clean-stale-branches': CleanBranchesOutput;
  'clean-orphan-worktrees': CleanWorktreesOutput;
};

// ── Workflow registration ───────────────────────────────────────

export function registerCleanupWorkflow(hatchet: HatchetClient) {
  const workflow = hatchet.workflow<CleanupInput, WorkflowOutput>({
    name: 'cleanup',
  });

  // Task 1: Clean stale branches (pipeline/* and integration/*)
  workflow.task({
    name: 'clean-stale-branches',
    executionTimeout: '5m',
    fn: async (input) => {
      const { projectPath, dryRun } = input;
      const staleDays = input.staleBranchDays ?? 7;
      const cutoffMs = staleDays * 24 * 60 * 60 * 1000;
      const now = Date.now();

      const deleted: string[] = [];
      const skipped: string[] = [];

      // List all local branches
      const result = await execute(
        'git',
        ['for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads/pipeline/', 'refs/heads/integration/'],
        { cwd: projectPath },
      );

      for (const line of result.stdout.split('\n').filter(Boolean)) {
        const [branch, timestampStr] = line.split(' ');
        if (!branch || !timestampStr) continue;

        const commitTime = parseInt(timestampStr, 10) * 1000;
        if (now - commitTime < cutoffMs) {
          skipped.push(branch);
          continue;
        }

        if (dryRun) {
          deleted.push(`[dry-run] ${branch}`);
          continue;
        }

        // Delete local
        await execute('git', ['branch', '-D', branch], {
          cwd: projectPath,
          reject: false,
        });

        // Delete remote
        await execute('git', ['push', 'origin', '--delete', branch], {
          cwd: projectPath,
          reject: false,
        });

        deleted.push(branch);
      }

      logger.info({ deleted: deleted.length, skipped: skipped.length }, 'Stale branch cleanup complete');

      return { deleted, skipped } as CleanBranchesOutput;
    },
  });

  // Task 2: Clean orphan worktrees (no parallel dependency — runs alongside)
  workflow.task({
    name: 'clean-orphan-worktrees',
    executionTimeout: '5m',
    fn: async (input) => {
      const { projectPath, dryRun } = input;

      const removed: string[] = [];
      const errors: string[] = [];

      // List worktrees
      const result = await execute(
        'git',
        ['worktree', 'list', '--porcelain'],
        { cwd: projectPath },
      );

      const worktrees: Array<{ path: string; branch?: string }> = [];
      let current: { path: string; branch?: string } | null = null;

      for (const line of result.stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          current = { path: line.slice('worktree '.length) };
          worktrees.push(current);
        } else if (line.startsWith('branch ') && current) {
          current.branch = line.slice('branch '.length).replace('refs/heads/', '');
        }
      }

      // Check each worktree — if its branch no longer exists, it's orphaned
      for (const wt of worktrees) {
        // Skip the main worktree
        if (wt.path === projectPath) continue;
        if (!wt.branch) continue;

        // Check if branch still exists
        const branchCheck = await execute(
          'git',
          ['rev-parse', '--verify', `refs/heads/${wt.branch}`],
          { cwd: projectPath, reject: false },
        );

        if (branchCheck.exitCode === 0) continue; // branch exists, not orphaned

        if (dryRun) {
          removed.push(`[dry-run] ${wt.path}`);
          continue;
        }

        try {
          await execute('git', ['worktree', 'remove', '--force', wt.path], {
            cwd: projectPath,
          });
          removed.push(wt.path);
        } catch (err: any) {
          errors.push(`${wt.path}: ${err.message}`);
        }
      }

      logger.info({ removed: removed.length, errors: errors.length }, 'Orphan worktree cleanup complete');

      return { removed, errors } as CleanWorktreesOutput;
    },
  });

  return workflow;
}
