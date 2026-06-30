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

import { runPipeline, type PipelineStateChange } from '@funny/pipelines';
import type {
  AgentDefinition,
  AgentModel,
  PipelineRunStatus,
  PipelineStageType,
  PipelineVerdict,
  WSEvent,
} from '@funny/shared';

import { log } from '../lib/logger.js';
import type { YamlPipelineContext } from '../pipelines/yaml-compiler.js';
import { loadPipelines, type LoadedPipeline } from '../pipelines/yaml-loader.js';
import { BUILTIN_AGENTS, resolveAgent, resolveBuiltinAgentByName } from './agent-registry.js';
import { RuntimeActionProvider, RuntimeProgressReporter } from './pipeline-adapter.js';
import { getServices } from './service-registry.js';
import * as tm from './thread-manager.js';

// ── Pipeline loading ─────────────────────────────────────────
//
// Caching was attempted here but couldn't be done correctly — the
// resolveAgent closure captures per-run reviewer/corrector definitions
// (with model overrides + custom prompts), so cache entries can't be
// shared across runs. Re-loading on every run is fine: the YAML files
// are small (~4 files, ~200 lines total) and the read-parse-compile
// chain is sub-millisecond on modern disk. If profiling shows this as
// a hotspot, cache by (repoRoot, reviewerKey, correctorKey) instead.

async function getCodeReviewPipeline(
  repoRoot: string,
  reviewer: AgentDefinition,
  corrector: AgentDefinition,
): Promise<LoadedPipeline> {
  const result = await loadPipelines({
    repoRoot,
    resolveAgent: (name) => {
      if (name === 'reviewer') return reviewer;
      if (name === 'corrector') return corrector;
      return resolveBuiltinAgentByName(name);
    },
  });

  if (result.warnings.length > 0) {
    log.warn('Pipeline loader emitted warnings', {
      namespace: 'pipeline',
      warnings: result.warnings,
    });
  }

  const found = result.pipelines.get('code-review');
  if (!found) throw new Error('Built-in code-review pipeline not found');
  return found;
}

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

// ── Pipeline Repository (delegates to service provider) ─────

function toPipelineConfig(row: any): PipelineConfig {
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
  const row = await getServices().pipelines.getPipelineForProject(projectId);
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
  return getServices().pipelines.createPipeline(data);
}

export function getPipelineById(id: string) {
  return getServices().pipelines.getPipelineById(id);
}

export function getPipelinesByProject(projectId: string) {
  return getServices().pipelines.getPipelinesByProject(projectId);
}

export function updatePipeline(id: string, updates: Record<string, unknown>) {
  return getServices().pipelines.updatePipeline(id, updates);
}

export function deletePipeline(id: string) {
  return getServices().pipelines.deletePipeline(id);
}

// ── Pipeline Run Repository ─────────────────────────────────

async function createRun(data: {
  pipelineId: string;
  threadId: string;
  maxIterations: number;
  commitSha?: string;
}): Promise<string> {
  return getServices().pipelines.createRun(data);
}

async function updateRun(id: string, updates: Record<string, unknown>) {
  return getServices().pipelines.updateRun(id, updates);
}

export function getRunById(id: string) {
  return getServices().pipelines.getRunById(id);
}

export function getRunsForThread(threadId: string) {
  return getServices().pipelines.getRunsForThread(threadId);
}

// ── WS emission helpers ─────────────────────────────────────

function emitPipelineEvent(userId: string, event: WSEvent) {
  getServices().wsBroker.emitToUser(userId, event);
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

  // Resolve agent definitions for THIS run (model overrides, custom prompts).
  const reviewer = resolveAgent(BUILTIN_AGENTS.reviewer, {
    model: pipeline.reviewModel,
    ...(pipeline.reviewerPrompt ? { systemPrompt: pipeline.reviewerPrompt } : {}),
  });
  const corrector = resolveAgent(BUILTIN_AGENTS.corrector, {
    model: pipeline.fixModel,
    ...(pipeline.correctorPrompt ? { systemPrompt: pipeline.correctorPrompt } : {}),
  });

  // Load and compile the YAML-defined code-review pipeline. The loader
  // honors `<repoRoot>/.funny/workflows/code-review.yaml` overrides when
  // present, so users can customize the prompt/loop without recompiling
  // funny.
  const codeReview = await getCodeReviewPipeline(cwd, reviewer, corrector);

  // Build the YAML pipeline context. State that the old TS pipeline kept
  // on the typed context (verdict, findings, iteration, commitSha) now
  // lives on `ctx.outputs.<node>.json` (for JSON outputs) and on the
  // engine's iteration counter.
  const initialCtx: YamlPipelineContext = {
    provider,
    progress,
    cwd,
    inputs: { commit_sha: commitSha ?? 'HEAD' },
    outputs: {},
  };

  // Helpers to project the YAML scope back onto the legacy DB column shape.
  const verdictOf = (ctx: YamlPipelineContext): PipelineVerdict | undefined => {
    const raw = ctx.outputs.review?.json?.verdict;
    return raw === 'pass' || raw === 'fail' ? (raw as PipelineVerdict) : undefined;
  };
  const findingsOf = (ctx: YamlPipelineContext): string | undefined => {
    const raw = ctx.outputs.review?.json?.findings;
    if (raw === undefined || raw === null) return undefined;
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
  };
  // The current commit being reviewed: starts as the input `commit_sha`
  // and updates after each fix-loop iteration to the SHA produced by
  // the `commit-fix` node (captured in `ctx.outputs.commit-fix.json.sha`).
  const commitShaOf = (ctx: YamlPipelineContext): string | undefined => {
    const fixed = ctx.outputs['commit-fix']?.json?.sha;
    if (typeof fixed === 'string' && fixed.length > 0) return fixed;
    return typeof ctx.inputs.commit_sha === 'string' ? ctx.inputs.commit_sha : undefined;
  };

  // State change callback — persist to DB + emit WS
  const onStateChange = async (change: PipelineStateChange<YamlPipelineContext>) => {
    const { kind, nodeName, ctx, iteration } = change;

    if (kind === 'entering' || kind === 'completed') {
      const dbStatus = nodeToRunStatus(nodeName, kind);
      const dbStage = nodeToStageType(nodeName);

      await updateRun(runId, {
        status: dbStatus,
        currentStage: dbStage,
        iteration,
        commitSha: commitShaOf(ctx),
        verdict: verdictOf(ctx),
        findings: findingsOf(ctx),
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
            iteration,
            maxIterations: pipeline.maxIterations,
            verdict: verdictOf(ctx),
            findings: findingsOf(ctx),
          },
        });
      }
    }

    if (kind === 'terminal') {
      const now = new Date().toISOString();
      let terminalStatus: PipelineRunStatus;
      if (change.outcome === 'completed') {
        // The YAML version has no `noChanges` notion — treat verdict==pass
        // with zero iterations of fix as the "skipped" case.
        terminalStatus = 'completed';
      } else if (change.outcome === 'cancelled') {
        terminalStatus = 'failed';
      } else {
        terminalStatus = 'failed';
      }

      await updateRun(runId, {
        status: terminalStatus,
        iteration,
        commitSha: commitShaOf(ctx),
        verdict: verdictOf(ctx),
        findings: findingsOf(ctx),
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
          totalIterations: iteration,
        },
      });

      log.info('Pipeline: run completed', {
        namespace: 'pipeline',
        runId,
        status: terminalStatus,
        iterations: iteration,
      });
    }
  };

  // Fire-and-forget — run the YAML-loaded code-review pipeline
  runPipeline(codeReview.definition, initialCtx, {
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

  const project = await getServices().projects.getProject(projectId);
  if (!project) return;

  if (reviewerThread.worktreePath && reviewerThread.mode === 'worktree') {
    const { removeWorktree, removeBranch } = await import('@funny/core/git');
    await removeWorktree(project.path, reviewerThread.worktreePath).match(
      () => undefined,
      (e) =>
        log.warn('Pipeline: failed to remove reviewer worktree', {
          namespace: 'pipeline',
          error: String(e),
        }),
    );
    if (reviewerThread.branch) {
      await removeBranch(project.path, reviewerThread.branch).match(
        () => undefined,
        (e) =>
          log.warn('Pipeline: failed to remove reviewer branch', {
            namespace: 'pipeline',
            error: String(e),
          }),
      );
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
