/**
 * Integrator — creates integration branch, merges, resolves conflicts, creates PR.
 *
 * Takes a ManifestReadyEntry and performs the full integration workflow:
 * 1. Creates integration/{branch} from main
 * 2. Merges pipeline/{branch} into it
 * 3. If conflicts: runs AgentExecutor for conflict resolution
 * 4. Pushes integration branch and creates GitHub PR
 *
 * Uses execute() directly for merge (not mergeBranch()) because we need
 * to keep conflicts in the working tree for the agent to resolve.
 *
 * The workflow is wrapped in a Saga for step tracking and automatic
 * compensation (rollback) on failure.
 */

import { join } from 'path';
import { AgentExecutor, ModelFactory } from '@funny/core/agents';
import type { AgentRole, AgentContext } from '@funny/core/agents';
import { execute, createPR } from '@funny/core/git';
import { Saga } from './saga.js';
import type { ManifestReadyEntry, ManifestPendingMergeEntry, IntegratorResult } from './manifest-types.js';
import type { PipelineEvent, PipelineEventType } from './types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import type { CircuitBreakers } from '../infrastructure/circuit-breaker.js';
import type { PipelineServiceConfig } from '../config/schema.js';
import { logger } from '../infrastructure/logger.js';

// ── Saga context ────────────────────────────────────────────────

interface IntegrationContext {
  entry: ManifestReadyEntry;
  cwd: string;           // main project path (for fetch, branch ops)
  worktreePath: string;  // temp worktree for integration work
  integrationBranch: string;
  originMain: string;
  baseSha: string;
  conflictsResolved: boolean;
  prNumber: number;
  prUrl: string;
}

// ── Rebase result ───────────────────────────────────────────────

export interface RebaseResult {
  success: boolean;
  conflicts_resolved?: boolean;
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────

function buildConflictPrompt(
  integrationBranch: string,
  pipelineBranch: string,
  conflictedFiles: string[],
): string {
  const fileList = conflictedFiles.map((f) => `- ${f}`).join('\n');
  return `You are resolving merge conflicts in a git repository.

## Context
The integration branch \`${integrationBranch}\` has conflicts after merging \`${pipelineBranch}\`.

## Conflicted files
${fileList}

## Instructions
1. Read each conflicted file.
2. Resolve all conflict markers (<<<<<<, ======, >>>>>>) by analyzing both sides semantically.
   - Prefer preserving functionality from both sides where possible.
   - If the changes are contradictory, prefer the pipeline branch changes (they are the reviewed changes).
3. Stage all resolved files with \`git add\`.
4. Commit with message: \`fix(integration): resolve merge conflicts for ${pipelineBranch}\`

Do NOT create new branches. Work on the current branch. Be precise and thorough.`;
}

function buildPRBody(entry: ManifestReadyEntry, conflictsResolved: boolean): string {
  const resultRows = Object.entries(entry.pipeline_result)
    .map(([agent, result]) => `| ${agent} | ${result.status} | ${result.details} |`)
    .join('\n');

  const corrections = entry.corrections_applied.length > 0
    ? `\n### Corrections Applied\n${entry.corrections_applied.map((c) => `- ${c}`).join('\n')}`
    : '';

  const conflicts = conflictsResolved
    ? '\n### Conflict Resolution\nMerge conflicts were automatically resolved by Claude (Opus).'
    : '';

  return `## Pipeline Results (Tier: ${entry.tier})

| Agent | Status | Details |
|-------|--------|---------|
${resultRows || '| — | — | No agent results recorded |'}
${corrections}${conflicts}

---
*Automated by funny Pipeline Service*
*Request ID: ${entry.request_id}*`;
}

// ── Integrator class ────────────────────────────────────────────

export class Integrator {
  private modelFactory: ModelFactory;
  private integrationPrefix: string;
  private mainBranch: string;
  private conflictModel: string;
  private conflictMaxTurns: number;

  constructor(
    private eventBus: EventBus,
    private config: PipelineServiceConfig,
    private circuitBreakers?: CircuitBreakers,
  ) {
    this.modelFactory = new ModelFactory({
      anthropic: {
        apiKey: process.env[config.llm_providers.anthropic.api_key_env],
        baseURL: config.llm_providers.anthropic.base_url || undefined,
      },
      'funny-api-acp': {
        apiKey: process.env[config.llm_providers.funny_api_acp.api_key_env],
        baseURL: config.llm_providers.funny_api_acp.base_url || undefined,
      },
      ollama: {
        baseURL: config.llm_providers.ollama.base_url || undefined,
      },
    });
    this.integrationPrefix = config.branch.integration_prefix;
    this.mainBranch = config.branch.main;
    this.conflictModel = config.agents.conflict.model;
    this.conflictMaxTurns = config.agents.conflict.maxTurns;
  }

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
   * Run the full integration workflow for a single branch (saga-backed).
   */
  async integrate(
    entry: ManifestReadyEntry,
    projectPath: string,
  ): Promise<IntegratorResult> {
    const { branch, pipeline_branch, request_id } = entry;
    const integrationBranch = `${this.integrationPrefix}${branch}`;
    const effectiveMain = entry.base_branch ?? this.mainBranch;
    const originMain = `origin/${effectiveMain}`;
    const safeBranch = branch.replace(/\//g, '-');
    const worktreePath = join(projectPath, '.pipeline', 'integration-worktrees', safeBranch);

    logger.info({ branch, integrationBranch, worktreePath, requestId: request_id }, 'Integration started');
    this.emitEvent('integration.started', request_id, { branch, integration_branch: integrationBranch });

    // Build saga context
    const ctx: IntegrationContext = {
      entry,
      cwd: projectPath,
      worktreePath,
      integrationBranch,
      originMain,
      baseSha: '',
      conflictsResolved: false,
      prNumber: 0,
      prUrl: '',
    };

    // Build saga with compensation steps
    const saga = new Saga<IntegrationContext>('integration', projectPath);

    saga.addStep({
      name: 'fetch_main',
      action: async (c) => {
        await execute('git', ['fetch', 'origin', effectiveMain], { cwd: c.cwd, reject: false });
        const { stdout: mainSha } = await execute('git', ['rev-parse', c.originMain], { cwd: c.cwd });
        c.baseSha = mainSha.trim();
      },
      // No compensation — fetch is idempotent
    });

    saga.addStep({
      name: 'create_integration_branch',
      action: async (c) => {
        // Clean up any stale worktree / branch from a previous run
        await execute('git', ['worktree', 'remove', '--force', c.worktreePath], { cwd: c.cwd, reject: false });
        await execute('git', ['branch', '-D', c.integrationBranch], { cwd: c.cwd, reject: false });
        // Create a temporary worktree with a new integration branch based on origin/main
        await execute('git', ['worktree', 'add', '-b', c.integrationBranch, c.worktreePath, c.originMain], { cwd: c.cwd });
      },
      compensate: async (c) => {
        await execute('git', ['worktree', 'remove', '--force', c.worktreePath], { cwd: c.cwd, reject: false });
        await execute('git', ['branch', '-D', c.integrationBranch], { cwd: c.cwd, reject: false });
      },
    });

    saga.addStep({
      name: 'merge_pipeline',
      action: async (c) => {
        // Worktrees share the same object store — local branches are accessible directly
        const mergeResult = await execute(
          'git',
          ['merge', '--no-ff', pipeline_branch, '-m', `Merge '${pipeline_branch}' into ${c.integrationBranch}`],
          { cwd: c.worktreePath, reject: false },
        );

        if (mergeResult.exitCode !== 0) {
          const { stdout: conflictOutput } = await execute(
            'git',
            ['diff', '--name-only', '--diff-filter=U'],
            { cwd: c.worktreePath, reject: false },
          );
          const conflictedFiles = conflictOutput.trim().split('\n').filter(Boolean);

          if (conflictedFiles.length === 0) {
            throw new Error(mergeResult.stderr || 'Merge failed without detectable conflicts');
          }

          logger.info({ branch, conflictedFiles }, 'Merge conflicts detected');
          this.emitEvent('integration.conflict.detected', request_id, {
            branch,
            conflicted_files: conflictedFiles,
            count: conflictedFiles.length,
          });

          // Resolve conflicts via Claude agent
          const resolved = await this.resolveConflicts(c.integrationBranch, pipeline_branch, conflictedFiles, c.worktreePath, effectiveMain);
          if (!resolved) {
            throw new Error('Claude agent failed to resolve merge conflicts');
          }

          c.conflictsResolved = true;
          this.emitEvent('integration.conflict.resolved', request_id, {
            branch,
            conflicted_files: conflictedFiles,
          });
        }
      },
      compensate: async (c) => {
        await execute('git', ['merge', '--abort'], { cwd: c.worktreePath, reject: false });
      },
    });

    saga.addStep({
      name: 'push_branch',
      action: async (c) => {
        const doPush = () => execute(
          'git',
          ['push', '-u', 'origin', c.integrationBranch, '--force-with-lease'],
          { cwd: c.worktreePath },
        );

        if (this.circuitBreakers) {
          await this.circuitBreakers.github.execute(doPush);
        } else {
          await doPush();
        }
      },
      compensate: async (c) => {
        await execute('git', ['push', 'origin', '--delete', c.integrationBranch], { cwd: c.cwd, reject: false });
      },
    });

    saga.addStep({
      name: 'create_pr',
      action: async (c) => {
        const prTitle = `Integrate: ${branch}`;
        const prBody = buildPRBody(entry, c.conflictsResolved);

        const doCreatePR = async () => {
          const prResult = createPR(c.worktreePath, prTitle, prBody, effectiveMain);
          return prResult.match(
            (output) => output,
            (err) => { throw new Error(`Failed to create PR: ${err.message}`); },
          );
        };

        let prOutput: string;
        if (this.circuitBreakers) {
          prOutput = await this.circuitBreakers.github.execute(doCreatePR);
        } else {
          prOutput = await doCreatePR();
        }

        const prUrl = prOutput.trim();
        const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
        c.prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : 0;
        c.prUrl = prUrl;

        logger.info({ branch, prNumber: c.prNumber, prUrl: c.prUrl }, 'PR created');
        this.emitEvent('integration.pr.created', request_id, {
          branch,
          pr_number: c.prNumber,
          pr_url: c.prUrl,
          integration_branch: c.integrationBranch,
        });
      },
      // No compensation — PR is visible and that's OK per SAD
    });

    saga.addStep({
      name: 'cleanup_worktree',
      action: async (c) => {
        await execute('git', ['worktree', 'remove', '--force', c.worktreePath], { cwd: c.cwd, reject: false });
      },
    });

    // Execute the saga
    try {
      await saga.execute(request_id, ctx);

      return {
        success: true,
        pr_number: ctx.prNumber,
        pr_url: ctx.prUrl,
        integration_branch: integrationBranch,
        base_main_sha: ctx.baseSha,
        conflicts_resolved: ctx.conflictsResolved,
      };
    } catch (err: any) {
      logger.error({ branch, err: err.message }, 'Integration saga failed');
      this.emitEvent('integration.failed', request_id, {
        branch,
        error: err.message,
      });

      // Clean up worktree on failure
      await execute('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectPath, reject: false });
      await execute('git', ['branch', '-D', integrationBranch], { cwd: projectPath, reject: false });

      return { success: false, error: err.message };
    }
  }

  // ── Rebase a stale integration branch ─────────────────────────

  /**
   * Rebase an integration branch onto the latest main.
   * Called when Director detects base_main_sha has diverged.
   */
  async rebase(
    entry: ManifestPendingMergeEntry,
    projectPath: string,
    newMainSha: string,
  ): Promise<RebaseResult> {
    const { integration_branch, branch, request_id } = entry;
    const cwd = projectPath;

    logger.info({ branch, integrationBranch: integration_branch }, 'Rebase started');

    try {
      // 1. Fetch latest main
      await execute('git', ['fetch', 'origin', this.mainBranch], { cwd, reject: false });

      // 2. Checkout integration branch
      await execute('git', ['checkout', integration_branch], { cwd });

      // 3. Attempt rebase
      const rebaseResult = await execute(
        'git',
        ['rebase', `origin/${this.mainBranch}`],
        { cwd, reject: false },
      );

      let conflictsResolved = false;

      if (rebaseResult.exitCode !== 0) {
        // Check for conflict markers
        const { stdout: conflictOutput } = await execute(
          'git',
          ['diff', '--name-only', '--diff-filter=U'],
          { cwd, reject: false },
        );
        const conflictedFiles = conflictOutput.trim().split('\n').filter(Boolean);

        if (conflictedFiles.length === 0) {
          // Rebase failed without conflicts — abort
          await execute('git', ['rebase', '--abort'], { cwd, reject: false });
          await execute('git', ['checkout', this.mainBranch], { cwd, reject: false });

          this.emitEvent('integration.pr.rebase_failed', request_id, {
            branch,
            error: 'Rebase failed without detectable conflicts',
          });
          return { success: false, error: 'Rebase failed without conflicts' };
        }

        // Resolve conflicts via Claude agent
        const resolved = await this.resolveConflicts(
          integration_branch,
          `origin/${this.mainBranch}`,
          conflictedFiles,
          cwd,
        );

        if (!resolved) {
          await execute('git', ['rebase', '--abort'], { cwd, reject: false });
          await execute('git', ['checkout', this.mainBranch], { cwd, reject: false });

          this.emitEvent('integration.pr.rebase_failed', request_id, {
            branch,
            error: 'Conflict resolution during rebase failed',
          });
          return { success: false, error: 'Conflict resolution during rebase failed' };
        }

        // Continue rebase after conflict resolution
        await execute('git', ['rebase', '--continue'], { cwd, reject: false });
        conflictsResolved = true;
      }

      // 4. Force push (circuit breaker protected)
      const doPush = () => execute(
        'git',
        ['push', '--force-with-lease', 'origin', integration_branch],
        { cwd },
      );

      if (this.circuitBreakers) {
        await this.circuitBreakers.github.execute(doPush);
      } else {
        await doPush();
      }

      // 5. Go back to main
      await execute('git', ['checkout', this.mainBranch], { cwd, reject: false });

      logger.info({ branch, newMainSha }, 'Rebase completed');
      this.emitEvent('integration.pr.rebased', request_id, {
        branch,
        pr_number: entry.pr_number,
        new_base_sha: newMainSha,
        conflicts_resolved: conflictsResolved,
      });

      return { success: true, conflicts_resolved: conflictsResolved };
    } catch (err: any) {
      logger.error({ branch, err: err.message }, 'Rebase failed');
      await execute('git', ['rebase', '--abort'], { cwd, reject: false });
      await execute('git', ['checkout', this.mainBranch], { cwd, reject: false });

      this.emitEvent('integration.pr.rebase_failed', request_id, {
        branch,
        error: err.message,
      });

      return { success: false, error: err.message };
    }
  }

  // ── Conflict resolution via AgentExecutor ──────────────────────

  private async resolveConflicts(
    integrationBranch: string,
    pipelineBranch: string,
    conflictedFiles: string[],
    cwd: string,
    baseBranch?: string,
  ): Promise<boolean> {
    const prompt = buildConflictPrompt(integrationBranch, pipelineBranch, conflictedFiles);

    logger.info({ conflictedFiles }, 'Starting conflict resolution agent');

    const role: AgentRole = {
      name: 'conflict-resolver',
      systemPrompt: prompt,
      model: this.conflictModel,
      provider: 'funny-api-acp',
      tools: [],
      maxTurns: this.conflictMaxTurns,
    };

    const context: AgentContext = {
      branch: integrationBranch,
      worktreePath: cwd,
      tier: 'large',
      diffStats: {
        files_changed: conflictedFiles.length,
        lines_added: 0,
        lines_deleted: 0,
        changed_files: conflictedFiles,
      },
      previousResults: [],
      baseBranch: baseBranch ?? this.mainBranch,
    };

    try {
      const doResolve = async () => {
        const resolved = this.modelFactory.resolve(role.provider, role.model);
        const executor = new AgentExecutor(resolved.baseURL, resolved.modelId, resolved.apiKey);
        const result = await executor.execute(role, context);
        return result.status !== 'error';
      };

      if (this.circuitBreakers) {
        return await this.circuitBreakers.claude.execute(doResolve);
      }
      return await doResolve();
    } catch (err: any) {
      logger.error({ err: err.message, conflictedFiles }, 'Conflict resolution agent failed');
      return false;
    }
  }

  async stopAll(): Promise<void> {
    // AgentExecutor is stateless — no subprocess to stop
  }
}
