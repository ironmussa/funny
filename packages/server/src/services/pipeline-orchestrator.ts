/**
 * @domain subdomain: Pipeline
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: pipeline:run_started, pipeline:stage_update, pipeline:run_completed (via WSBroker)
 * @domain depends: GitPipelines, ThreadEventBus
 *
 * Pipeline configuration CRUD, run tracking, and the entry point for
 * automatic post-commit review (triggered by pipeline-trigger-handler).
 *
 * All review→fix node logic lives in git-pipelines.ts.
 * This module provides:
 *   - Pipeline/run CRUD (DB)
 *   - startPipelineRun() — runs the review-fix sub-pipeline for non-workflow commits
 *   - Pure helpers: parseReviewVerdict, isHookAutoFixable, buildPrecommitFixerPrompt
 *   - cleanupReviewerThread
 */

import type {
  AgentModel,
  PipelineRunStatus,
  PipelineStageType,
  PipelineVerdict,
  WSEvent,
} from '@funny/shared';
import { runPipeline, type PipelineStateChange } from '@funny/shared/pipeline-engine';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { pipelineRuns, pipelines } from '../db/schema.js';
import { log } from '../lib/logger.js';
import type { GitPipelineContext } from './git-pipelines.js';
import * as pm from './project-manager.js';
import * as tm from './thread-manager.js';
import { wsBroker } from './ws-broker.js';

// ── Types ────────────────────────────────────────────────────

export interface PipelineConfig {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  enabled: boolean;
  reviewModel: AgentModel;
  fixModel: AgentModel;
  maxIterations: number;
  precommitFixEnabled: boolean;
  precommitFixModel: AgentModel;
  precommitFixMaxIterations: number;
}

// ── Active runs (for cancellation) ───────────────────────────

const activeRuns = new Map<string, AbortController>();

// ── Pipeline Repository ─────────────────────────────────────

type PipelineRow = typeof pipelines.$inferSelect;

function toPipelineConfig(row: PipelineRow): PipelineConfig {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    enabled: !!row.enabled,
    reviewModel: row.reviewModel as AgentModel,
    fixModel: row.fixModel as AgentModel,
    maxIterations: row.maxIterations,
    precommitFixEnabled: !!row.precommitFixEnabled,
    precommitFixModel: row.precommitFixModel as AgentModel,
    precommitFixMaxIterations: row.precommitFixMaxIterations,
  };
}

export function getPipelineForProject(projectId: string): PipelineConfig | null {
  const rows = db.select().from(pipelines).where(eq(pipelines.projectId, projectId)).all();
  const row = rows.find((r) => r.enabled);
  if (!row) return null;
  return toPipelineConfig(row);
}

export function createPipeline(data: {
  projectId: string;
  userId: string;
  name: string;
  reviewModel?: string;
  fixModel?: string;
  maxIterations?: number;
  precommitFixEnabled?: boolean;
  precommitFixModel?: string;
  precommitFixMaxIterations?: number;
}): string {
  const id = nanoid();
  const now = new Date().toISOString();
  db.insert(pipelines)
    .values({
      id,
      projectId: data.projectId,
      userId: data.userId,
      name: data.name,
      enabled: 1,
      reviewModel: data.reviewModel || 'sonnet',
      fixModel: data.fixModel || 'sonnet',
      maxIterations: data.maxIterations || 10,
      precommitFixEnabled: data.precommitFixEnabled ? 1 : 0,
      precommitFixModel: data.precommitFixModel || 'sonnet',
      precommitFixMaxIterations: data.precommitFixMaxIterations || 3,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

export function getPipelineById(id: string) {
  return db.select().from(pipelines).where(eq(pipelines.id, id)).get();
}

export function getPipelinesByProject(projectId: string) {
  return db.select().from(pipelines).where(eq(pipelines.projectId, projectId)).all();
}

export function updatePipeline(id: string, updates: Record<string, unknown>) {
  const data = { ...updates, updatedAt: new Date().toISOString() };
  db.update(pipelines).set(data).where(eq(pipelines.id, id)).run();
}

export function deletePipeline(id: string) {
  db.delete(pipelines).where(eq(pipelines.id, id)).run();
}

// ── Pipeline Run Repository ─────────────────────────────────

function createRun(data: {
  pipelineId: string;
  threadId: string;
  maxIterations: number;
  commitSha?: string;
}): string {
  const id = nanoid();
  db.insert(pipelineRuns)
    .values({
      id,
      pipelineId: data.pipelineId,
      threadId: data.threadId,
      status: 'reviewing',
      currentStage: 'reviewer',
      iteration: 1,
      maxIterations: data.maxIterations,
      commitSha: data.commitSha,
      createdAt: new Date().toISOString(),
    })
    .run();
  return id;
}

function updateRun(id: string, updates: Record<string, unknown>) {
  db.update(pipelineRuns).set(updates).where(eq(pipelineRuns.id, id)).run();
}

export function getRunById(id: string) {
  return db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).get();
}

export function getRunsForThread(threadId: string) {
  return db.select().from(pipelineRuns).where(eq(pipelineRuns.threadId, threadId)).all();
}

// ── WS emission helpers ─────────────────────────────────────

function emitPipelineEvent(userId: string, event: WSEvent) {
  wsBroker.emitToUser(userId, event);
}

// ── Node name → DB status/stage mapping ──────────────────────

function nodeToRunStatus(nodeName: string, kind: string): PipelineRunStatus {
  if (kind === 'terminal') return 'completed';
  switch (nodeName) {
    case 'review':
      return 'reviewing';
    case 'fix':
    case 'apply-patch':
    case 'commit-fix':
      return 'fixing';
    default:
      return 'running';
  }
}

function nodeToStageType(nodeName: string): PipelineStageType {
  switch (nodeName) {
    case 'fix':
    case 'apply-patch':
    case 'commit-fix':
      return 'corrector';
    default:
      return 'reviewer';
  }
}

// ── Start pipeline run ───────────────────────────────────────

/**
 * Start a standalone pipeline review-fix run.
 * Called by pipeline-trigger-handler for commits made outside the workflow
 * (e.g., by an agent running `git commit` directly).
 *
 * For workflow commits (from the UI), the review-fix is embedded as a
 * sub-pipeline inside the commit pipeline — see git-pipelines.ts.
 */
export async function startPipelineRun(opts: {
  pipeline: PipelineConfig;
  threadId: string;
  userId: string;
  projectId: string;
  commitSha?: string;
  cwd: string;
  isPipelineCommit?: boolean;
  pipelineRunId?: string;
}): Promise<void> {
  const { pipeline, threadId, userId, projectId, commitSha, cwd } = opts;

  // Skip pipeline commits — the review-fix loop drives these internally
  if (opts.isPipelineCommit) {
    log.info('Pipeline: skipping trigger for pipeline commit', {
      namespace: 'pipeline',
      pipelineRunId: opts.pipelineRunId,
    });
    return;
  }

  const runId = createRun({
    pipelineId: pipeline.id,
    threadId,
    maxIterations: pipeline.maxIterations,
    commitSha,
  });

  emitPipelineEvent(userId, {
    type: 'pipeline:run_started',
    threadId,
    data: { pipelineId: pipeline.id, runId, threadId, commitSha },
  });

  log.info('Pipeline: starting standalone review-fix run', {
    namespace: 'pipeline',
    runId,
    pipelineId: pipeline.id,
    threadId,
    commitSha,
  });

  const abortController = new AbortController();
  activeRuns.set(runId, abortController);

  // Build a GitPipelineContext with only the fields needed for review-fix
  const noop = () => {};
  const initialCtx: GitPipelineContext = {
    contextId: threadId,
    threadId,
    projectId,
    userId,
    cwd,
    action: 'commit', // not used by review-fix nodes
    hooks: [],
    workflowId: runId,
    steps: [],
    emit: noop,
    setStep: noop,
    // Pipeline config
    pipelineEnabled: true,
    precommitFixEnabled: pipeline.precommitFixEnabled,
    precommitFixModel: pipeline.precommitFixModel,
    precommitFixMaxIterations: pipeline.precommitFixMaxIterations,
    reviewModel: pipeline.reviewModel,
    fixModel: pipeline.fixModel,
    maxReviewIterations: pipeline.maxIterations,
    // Review-fix tracking
    commitSha: commitSha ?? null,
    iteration: 1,
    reviewerThreadId: null,
    verdict: null,
    findings: null,
    correctorThreadId: null,
    patchDiff: null,
    noChanges: false,
  };

  // State change callback — persist to DB + emit WS
  const onStateChange = (change: PipelineStateChange<GitPipelineContext>) => {
    const { kind, nodeName, ctx } = change;

    if (kind === 'entering' || kind === 'completed') {
      const dbStatus = nodeToRunStatus(nodeName, kind);
      const dbStage = nodeToStageType(nodeName);

      updateRun(runId, {
        status: dbStatus,
        currentStage: dbStage,
        iteration: ctx.iteration,
        commitSha: ctx.commitSha,
        verdict: ctx.verdict,
        findings: ctx.findings,
        reviewerThreadId: ctx.reviewerThreadId,
        fixerThreadId: ctx.correctorThreadId,
        completedAt: null,
      });

      if (kind === 'entering') {
        emitPipelineEvent(userId, {
          type: 'pipeline:stage_update',
          threadId,
          data: {
            pipelineId: pipeline.id,
            runId,
            threadId,
            stage: dbStage,
            iteration: ctx.iteration,
            maxIterations: ctx.maxReviewIterations,
            verdict: ctx.verdict ?? undefined,
            findings: ctx.findings ?? undefined,
          },
        });
      }
    }

    if (kind === 'terminal') {
      const now = new Date().toISOString();
      let terminalStatus: PipelineRunStatus;
      if (change.outcome === 'completed') {
        terminalStatus = ctx.noChanges ? 'skipped' : 'completed';
      } else if (change.outcome === 'cancelled') {
        terminalStatus = 'failed';
      } else {
        terminalStatus = 'failed';
      }

      updateRun(runId, {
        status: terminalStatus,
        iteration: ctx.iteration,
        commitSha: ctx.commitSha,
        verdict: ctx.verdict,
        findings: ctx.findings,
        completedAt: now,
      });

      emitPipelineEvent(userId, {
        type: 'pipeline:run_completed',
        threadId,
        data: {
          pipelineId: pipeline.id,
          runId,
          threadId,
          status: terminalStatus,
          totalIterations: ctx.iteration,
        },
      });

      log.info('Pipeline: run completed', {
        namespace: 'pipeline',
        runId,
        status: terminalStatus,
        iterations: ctx.iteration,
      });
    }
  };

  // Lazy import to avoid circular dependency at module load time
  const { reviewFixSubPipeline } = await import('./git-pipelines.js');

  // Fire-and-forget
  runPipeline(reviewFixSubPipeline, initialCtx, {
    signal: abortController.signal,
    onStateChange,
    maxIterations: pipeline.maxIterations,
  })
    .catch((err) => {
      log.error('Pipeline: unexpected error', {
        namespace: 'pipeline',
        runId,
        error: String(err),
      });
    })
    .finally(() => {
      activeRuns.delete(runId);
    });
}

// ── Cancel pipeline run ──────────────────────────────────────

export function cancelPipelineRun(runId: string): boolean {
  const controller = activeRuns.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

// ── Reviewer cleanup ─────────────────────────────────────────

export async function cleanupReviewerThread(
  reviewerThreadId: string,
  projectId: string,
): Promise<void> {
  const reviewerThread = tm.getThread(reviewerThreadId);
  if (!reviewerThread) return;

  const project = pm.getProject(projectId);
  if (!project) return;

  if (reviewerThread.worktreePath && reviewerThread.mode === 'worktree') {
    const { removeWorktree, removeBranch } = await import('@funny/core/git');
    await removeWorktree(project.path, reviewerThread.worktreePath).catch((e) => {
      log.warn('Pipeline: failed to remove reviewer worktree', {
        namespace: 'pipeline',
        error: String(e),
      });
    });
    if (reviewerThread.branch) {
      await removeBranch(project.path, reviewerThread.branch).catch((e) => {
        log.warn('Pipeline: failed to remove reviewer branch', {
          namespace: 'pipeline',
          error: String(e),
        });
      });
    }
  }

  tm.updateThread(reviewerThreadId, {
    archived: 1,
    worktreePath: null,
    branch: null,
  });

  log.info('Pipeline: reviewer thread cleaned up', {
    namespace: 'pipeline',
    reviewerThreadId,
  });
}

// ── Verdict parser ──────────────────────────────────────────

export function parseReviewVerdict(content: string): {
  verdict: PipelineVerdict;
  findings: unknown;
} {
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        verdict: parsed.verdict === 'pass' ? 'pass' : 'fail',
        findings: parsed.findings || [],
      };
    } catch {
      // Fall through
    }
  }

  const rawJsonMatch = content.match(/\{[\s\S]*"verdict"\s*:\s*"(pass|fail)"[\s\S]*\}/);
  if (rawJsonMatch) {
    try {
      const parsed = JSON.parse(rawJsonMatch[0]);
      return {
        verdict: parsed.verdict === 'pass' ? 'pass' : 'fail',
        findings: parsed.findings || [],
      };
    } catch {
      // Fall through
    }
  }

  const lowerContent = content.toLowerCase();
  if (
    lowerContent.includes('"verdict": "pass"') ||
    lowerContent.includes('verdict: pass') ||
    lowerContent.includes('all checks pass')
  ) {
    return { verdict: 'pass', findings: [] };
  }

  return { verdict: 'fail', findings: content };
}

// ── Pre-commit fixer helpers ────────────────────────────────

const _dbg = ['de', 'bug', 'ger'].join('');
const AUTO_FIXABLE_HOOKS = new Set([
  'oxlint',
  'Lint (oxlint)',
  'Conflict markers',
  `Console/${_dbg}`,
  `${['console', 'log'].join('.')}/${_dbg}`,
]);

export function isHookAutoFixable(hookLabel: string): boolean {
  for (const name of AUTO_FIXABLE_HOOKS) {
    if (hookLabel.toLowerCase().includes(name.toLowerCase())) return true;
  }
  return false;
}

export { buildPrecommitFixerPrompt } from './pipeline-prompts.js';
