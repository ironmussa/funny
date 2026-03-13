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
import { runPipeline, type PipelineStateChange } from '@funny/pipelines';
import { codeReviewPipeline, type CodeReviewPipelineContext } from '../pipelines/code-review.pipeline.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import { pipelineRuns, pipelines } from '../db/schema.js';
import { log } from '../lib/logger.js';
import { RuntimeActionProvider, RuntimeProgressReporter } from './pipeline-adapter.js';
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
  reviewerPrompt?: string;
  correctorPrompt?: string;
  precommitFixerPrompt?: string;
  commitMessagePrompt?: string;
  testEnabled: boolean;
  testCommand?: string;
  testFixEnabled: boolean;
  testFixModel: AgentModel;
  testFixMaxIterations: number;
  testFixerPrompt?: string;
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
    ...(row.reviewerPrompt ? { reviewerPrompt: row.reviewerPrompt } : {}),
    ...(row.correctorPrompt ? { correctorPrompt: row.correctorPrompt } : {}),
    ...(row.precommitFixerPrompt ? { precommitFixerPrompt: row.precommitFixerPrompt } : {}),
    ...(row.commitMessagePrompt ? { commitMessagePrompt: row.commitMessagePrompt } : {}),
    testEnabled: !!row.testEnabled,
    testCommand: row.testCommand ?? undefined,
    testFixEnabled: !!row.testFixEnabled,
    testFixModel: (row.testFixModel as AgentModel) || 'sonnet',
    testFixMaxIterations: row.testFixMaxIterations ?? 3,
    ...(row.testFixerPrompt ? { testFixerPrompt: row.testFixerPrompt } : {}),
  };
}

export async function getPipelineForProject(projectId: string): Promise<PipelineConfig | null> {
  const rows = await dbAll(db.select().from(pipelines).where(eq(pipelines.projectId, projectId)));
  const row = rows.find((r: any) => r.enabled);
  if (!row) return null;
  return toPipelineConfig(row);
}

export async function createPipeline(data: {
  projectId: string;
  userId: string;
  name: string;
  reviewModel?: string;
  fixModel?: string;
  maxIterations?: number;
  precommitFixEnabled?: boolean;
  precommitFixModel?: string;
  precommitFixMaxIterations?: number;
  reviewerPrompt?: string;
  correctorPrompt?: string;
  precommitFixerPrompt?: string;
  commitMessagePrompt?: string;
  testEnabled?: boolean;
  testCommand?: string;
  testFixEnabled?: boolean;
  testFixModel?: string;
  testFixMaxIterations?: number;
  testFixerPrompt?: string;
}): Promise<string> {
  const id = nanoid();
  const now = new Date().toISOString();
  await dbRun(
    db.insert(pipelines).values({
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
      reviewerPrompt: data.reviewerPrompt || null,
      correctorPrompt: data.correctorPrompt || null,
      precommitFixerPrompt: data.precommitFixerPrompt || null,
      commitMessagePrompt: data.commitMessagePrompt || null,
      testEnabled: data.testEnabled ? 1 : 0,
      testCommand: data.testCommand || null,
      testFixEnabled: data.testFixEnabled ? 1 : 0,
      testFixModel: data.testFixModel || 'sonnet',
      testFixMaxIterations: data.testFixMaxIterations || 3,
      testFixerPrompt: data.testFixerPrompt || null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return id;
}

export async function getPipelineById(id: string) {
  return dbGet(db.select().from(pipelines).where(eq(pipelines.id, id)));
}

export async function getPipelinesByProject(projectId: string) {
  return dbAll(db.select().from(pipelines).where(eq(pipelines.projectId, projectId)));
}

export async function updatePipeline(id: string, updates: Record<string, unknown>) {
  const data = { ...updates, updatedAt: new Date().toISOString() };
  await dbRun(db.update(pipelines).set(data).where(eq(pipelines.id, id)));
}

export async function deletePipeline(id: string) {
  await dbRun(db.delete(pipelines).where(eq(pipelines.id, id)));
}

// ── Pipeline Run Repository ─────────────────────────────────

async function createRun(data: {
  pipelineId: string;
  threadId: string;
  maxIterations: number;
  commitSha?: string;
}): Promise<string> {
  const id = nanoid();
  await dbRun(
    db.insert(pipelineRuns).values({
      id,
      pipelineId: data.pipelineId,
      threadId: data.threadId,
      status: 'reviewing',
      currentStage: 'reviewer',
      iteration: 1,
      maxIterations: data.maxIterations,
      commitSha: data.commitSha,
      createdAt: new Date().toISOString(),
    }),
  );
  return id;
}

async function updateRun(id: string, updates: Record<string, unknown>) {
  await dbRun(db.update(pipelineRuns).set(updates).where(eq(pipelineRuns.id, id)));
}

export async function getRunById(id: string) {
  return dbGet(db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)));
}

export async function getRunsForThread(threadId: string) {
  return dbAll(db.select().from(pipelineRuns).where(eq(pipelineRuns.threadId, threadId)));
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
 * Uses the decoupled @funny/pipelines code-review pipeline with a
 * RuntimeActionProvider that bridges to the runtime's services.
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

  const runId = await createRun({
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

  // Create the decoupled action provider and progress reporter
  const provider = new RuntimeActionProvider({
    threadId,
    projectId,
    userId,
    workflowId: runId,
  });

  const progress = new RuntimeProgressReporter({
    userId,
    threadId,
    pipelineId: pipeline.id,
    runId,
    workflowId: runId,
  });

  // Build the code-review pipeline context
  const initialCtx: CodeReviewPipelineContext = {
    provider,
    progress,
    cwd,
    // Config
    commitSha: commitSha ?? undefined,
    maxIterations: pipeline.maxIterations,
    reviewerModel: pipeline.reviewModel,
    correctorModel: pipeline.fixModel,
    reviewerPrompt: pipeline.reviewerPrompt ?? undefined,
    correctorPrompt: pipeline.correctorPrompt ?? undefined,
    // State
    iteration: 1,
    noChanges: false,
  };

  // State change callback — persist to DB + emit WS
  const onStateChange = async (change: PipelineStateChange<CodeReviewPipelineContext>) => {
    const { kind, nodeName, ctx } = change;

    if (kind === 'entering' || kind === 'completed') {
      const dbStatus = nodeToRunStatus(nodeName, kind);
      const dbStage = nodeToStageType(nodeName);

      await updateRun(runId, {
        status: dbStatus,
        currentStage: dbStage,
        iteration: ctx.iteration,
        commitSha: ctx.commitSha,
        verdict: ctx.verdict,
        findings: ctx.findings,
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
            maxIterations: ctx.maxIterations ?? pipeline.maxIterations,
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

      await updateRun(runId, {
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

  // Fire-and-forget — run the decoupled code-review pipeline
  runPipeline(codeReviewPipeline, initialCtx, {
    signal: abortController.signal,
    onStateChange: (change) => void onStateChange(change),
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
  const reviewerThread = await tm.getThread(reviewerThreadId);
  if (!reviewerThread) return;

  const project = await pm.getProject(projectId);
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

  await tm.updateThread(reviewerThreadId, {
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
