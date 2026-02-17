/**
 * BranchCleaner — deletes pipeline/* and integration/* branches after lifecycle ends.
 *
 * Cleanup triggers:
 *   - pipeline.completed → delete pipeline/{branch}
 *   - integration.pr.merged → delete both pipeline/* and integration/*
 *   - pipeline.failed → keep if keep_on_failure=true, else delete
 */

import { execute } from '@funny/core/git';
import type { EventBus } from '../infrastructure/event-bus.js';
import type { PipelineEvent, PipelineEventType } from './types.js';
import { logger } from '../infrastructure/logger.js';

// ── Types ───────────────────────────────────────────────────────

export interface CleanupConfig {
  keep_on_failure: boolean;
  stale_branch_days: number;
}

export interface CleanupResult {
  deleted_local: string[];
  deleted_remote: string[];
  errors: string[];
}

// ── BranchCleaner ───────────────────────────────────────────────

export class BranchCleaner {
  constructor(
    private eventBus: EventBus,
    private config: CleanupConfig,
  ) {}

  private emitEvent(
    eventType: PipelineEventType,
    requestId: string,
    data: Record<string, unknown> = {},
  ): void {
    const event: PipelineEvent = {
      event_type: eventType,
      request_id: requestId,
      timestamp: new Date().toISOString(),
      data,
    };
    this.eventBus.publish(event);
  }

  /**
   * Delete a branch locally and remotely.
   */
  async deleteBranch(
    projectPath: string,
    branchName: string,
  ): Promise<{ local: boolean; remote: boolean }> {
    let local = false;
    let remote = false;

    // Delete local branch
    const localResult = await execute(
      'git',
      ['branch', '-D', branchName],
      { cwd: projectPath, reject: false },
    );
    if (localResult.exitCode === 0) {
      local = true;
    }

    // Delete remote branch
    const remoteResult = await execute(
      'git',
      ['push', 'origin', '--delete', branchName],
      { cwd: projectPath, reject: false },
    );
    if (remoteResult.exitCode === 0) {
      remote = true;
    }

    return { local, remote };
  }

  /**
   * Full cleanup after a PR is merged.
   * Deletes both pipeline/{branch} and integration/{branch}.
   */
  async cleanupAfterMerge(
    projectPath: string,
    branch: string,
    pipelineBranch: string,
    integrationBranch: string,
    requestId: string,
  ): Promise<CleanupResult> {
    const result: CleanupResult = { deleted_local: [], deleted_remote: [], errors: [] };

    this.emitEvent('cleanup.started', requestId, {
      branch,
      trigger: 'pr_merged',
      branches: [integrationBranch, pipelineBranch],
    });

    for (const branchName of [integrationBranch, pipelineBranch]) {
      try {
        const { local, remote } = await this.deleteBranch(projectPath, branchName);
        if (local) result.deleted_local.push(branchName);
        if (remote) result.deleted_remote.push(branchName);
      } catch (err: any) {
        result.errors.push(`${branchName}: ${err.message}`);
        logger.error({ branch: branchName, err: err.message }, 'Branch cleanup failed');
      }
    }

    this.emitEvent('cleanup.completed', requestId, {
      branch,
      deleted_local: result.deleted_local,
      deleted_remote: result.deleted_remote,
      errors: result.errors,
    });

    logger.info(
      { branch, deleted: result.deleted_local, errors: result.errors.length },
      'Post-merge cleanup completed',
    );

    return result;
  }

  /**
   * Cleanup after pipeline approval — delete only the pipeline branch.
   */
  async cleanupAfterPipelineApproved(
    projectPath: string,
    pipelineBranch: string,
    requestId: string,
  ): Promise<CleanupResult> {
    const result: CleanupResult = { deleted_local: [], deleted_remote: [], errors: [] };

    this.emitEvent('cleanup.started', requestId, {
      pipeline_branch: pipelineBranch,
      trigger: 'pipeline_approved',
    });

    try {
      const { local, remote } = await this.deleteBranch(projectPath, pipelineBranch);
      if (local) result.deleted_local.push(pipelineBranch);
      if (remote) result.deleted_remote.push(pipelineBranch);
    } catch (err: any) {
      result.errors.push(`${pipelineBranch}: ${err.message}`);
    }

    this.emitEvent('cleanup.completed', requestId, {
      pipeline_branch: pipelineBranch,
      deleted_local: result.deleted_local,
      deleted_remote: result.deleted_remote,
    });

    return result;
  }

  /**
   * Handle failed pipeline — keep branch if configured, otherwise delete.
   */
  async handleFailedPipeline(
    projectPath: string,
    pipelineBranch: string,
    requestId: string,
  ): Promise<void> {
    if (this.config.keep_on_failure) {
      logger.info(
        { pipelineBranch },
        'Keeping failed pipeline branch for debugging (keep_on_failure=true)',
      );
      return;
    }

    await this.deleteBranch(projectPath, pipelineBranch);
    logger.info({ pipelineBranch }, 'Deleted failed pipeline branch');
  }
}
