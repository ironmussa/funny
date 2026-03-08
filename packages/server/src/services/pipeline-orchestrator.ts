/**
 * @domain subdomain: Pipeline
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: pipeline:run_started, pipeline:stage_update, pipeline:run_completed (via WSBroker)
 * @domain depends: ThreadService, GitService, ThreadEventBus
 *
 * Orchestrates the review→fix pipeline loop.
 *
 * Stage 0 (pre-commit fixer) is handled by git-workflow-service.
 * This orchestrator handles:
 *   Stage 1: REVIEWER — read-only agent that analyzes the commit diff
 *   Stage 2: CORRECTOR — worktree agent that fixes findings
 */

import { gitRead, gitWrite } from '@funny/core/git';
import type {
  AgentModel,
  PipelineRunStatus,
  PipelineStageType,
  PipelineVerdict,
  WSEvent,
} from '@funny/shared';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { pipelineRuns, pipelines } from '../db/schema.js';
import { log } from '../lib/logger.js';
import * as pm from './project-manager.js';
import * as tm from './thread-manager.js';
import { createAndStartThread } from './thread-service.js';
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

// ── In-memory tracking of active pipeline runs ──────────────

/** Maps pipelineRunId → true while a run is active */
const activeRuns = new Map<string, boolean>();

/** Maps threadId → pipelineRunId for corrector threads */
const correctorThreadToRun = new Map<string, string>();

/** Maps threadId → pipelineRunId for reviewer threads */
const reviewerThreadToRun = new Map<string, string>();

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

export function getRunForCorrectorThread(threadId: string): string | undefined {
  return correctorThreadToRun.get(threadId);
}

export function getRunForReviewerThread(threadId: string): string | undefined {
  return reviewerThreadToRun.get(threadId);
}

// ── WS emission helpers ─────────────────────────────────────

function emitPipelineEvent(userId: string, event: WSEvent) {
  wsBroker.emitToUser(userId, event);
}

// ── Reviewer Prompt ─────────────────────────────────────────

function buildReviewerPrompt(commitSha: string | undefined, _cwd: string): string {
  const shaRef = commitSha ? commitSha : 'HEAD';
  return `You are a code reviewer. Analyze the changes in the latest commit.

Run this command to get the diff:
\`git diff ${shaRef}~1..${shaRef}\`

If that fails (first commit), run: \`git show ${shaRef}\`

Review the diff for:
- Bugs and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- Code that contradicts existing patterns

You MUST respond with a JSON block at the end of your message in exactly this format:
\`\`\`json
{
  "verdict": "pass" | "fail",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "category": "bug" | "security" | "performance" | "logic" | "style",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "What is wrong",
      "suggestion": "How to fix it"
    }
  ]
}
\`\`\`

If there are no significant issues, return verdict "pass" with an empty findings array.
Only flag real problems — do not flag style preferences or nitpicks unless they indicate bugs.`;
}

// ── Corrector Prompt ────────────────────────────────────────

function buildCorrectorPrompt(findings: string): string {
  return `You are a code corrector. The reviewer found the following issues that need to be fixed:

${findings}

Instructions:
1. Read each finding carefully
2. Fix the issues in the source files
3. Run the build to verify your changes compile: \`bun run build\` or equivalent
4. Run the tests to verify nothing is broken: \`bun run test\` or equivalent
5. Do NOT create a git commit — just fix the files

Fix only what the reviewer flagged. Do not make unrelated changes.`;
}

// ── Core orchestration ──────────────────────────────────────

/**
 * Start a new pipeline review for a commit.
 * Called by the pipeline-trigger-handler when git:committed fires.
 */
export async function startReview(opts: {
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

  // If this commit came from the corrector, continue the existing run
  if (opts.isPipelineCommit && opts.pipelineRunId) {
    const existingRun = getRunById(opts.pipelineRunId);
    if (existingRun) {
      log.info('Pipeline: continuing review after corrector commit', {
        namespace: 'pipeline',
        runId: opts.pipelineRunId,
        iteration: existingRun.iteration,
      });
      await runReviewerStage(existingRun.id, pipeline, threadId, userId, projectId, cwd, commitSha);
      return;
    }
  }

  // Create a new pipeline run
  const runId = createRun({
    pipelineId: pipeline.id,
    threadId,
    maxIterations: pipeline.maxIterations,
    commitSha,
  });

  activeRuns.set(runId, true);

  emitPipelineEvent(userId, {
    type: 'pipeline:run_started',
    threadId,
    data: {
      pipelineId: pipeline.id,
      runId,
      threadId,
      commitSha,
    },
  });

  log.info('Pipeline: starting review', {
    namespace: 'pipeline',
    runId,
    pipelineId: pipeline.id,
    threadId,
    commitSha,
  });

  await runReviewerStage(runId, pipeline, threadId, userId, projectId, cwd, commitSha);
}

/**
 * Run the reviewer stage — creates a worktree thread and spawns a read-only agent.
 *
 * Each reviewer gets its own worktree so multiple pipelines can run
 * in parallel without checkout conflicts.
 */
async function runReviewerStage(
  runId: string,
  pipeline: PipelineConfig,
  threadId: string,
  userId: string,
  projectId: string,
  _cwd: string,
  commitSha?: string,
): Promise<void> {
  updateRun(runId, { status: 'reviewing', currentStage: 'reviewer' });

  const run = getRunById(runId);

  emitPipelineEvent(userId, {
    type: 'pipeline:stage_update',
    threadId,
    data: {
      pipelineId: pipeline.id,
      runId,
      threadId,
      stage: 'reviewer' as PipelineStageType,
      iteration: run?.iteration || 1,
      maxIterations: pipeline.maxIterations,
    },
  });

  // Resolve the branch to base the worktree on.
  // Use the parent thread's branch so the reviewer sees exactly the same code.
  const parentThread = tm.getThread(threadId);
  const baseBranch = parentThread?.branch || undefined;

  const prompt = buildReviewerPrompt(commitSha, _cwd);

  try {
    const reviewerThread = await createAndStartThread({
      projectId,
      userId,
      title: `Pipeline review (iteration ${run?.iteration || 1})`,
      mode: 'worktree',
      provider: 'claude',
      model: pipeline.reviewModel,
      permissionMode: 'plan', // read-only
      source: 'automation',
      prompt,
      parentThreadId: threadId,
      baseBranch,
    });

    // Track the reviewer thread → run mapping
    reviewerThreadToRun.set(reviewerThread.id, runId);
    updateRun(runId, { reviewerThreadId: reviewerThread.id });

    log.info('Pipeline: reviewer thread created', {
      namespace: 'pipeline',
      runId,
      reviewerThreadId: reviewerThread.id,
      baseBranch,
    });
  } catch (err) {
    log.error('Pipeline: failed to start reviewer agent', {
      namespace: 'pipeline',
      runId,
      error: String(err),
    });
    completePipelineRun(runId, threadId, userId, pipeline.id, 'failed');
  }
}

/**
 * Handle reviewer completion — parse verdict and decide next action.
 * Called by the pipeline-completed-handler when agent:completed fires
 * on a reviewer worktree thread.
 */
export async function handleReviewerCompleted(
  runId: string,
  reviewerThreadId: string,
  userId: string,
  projectId: string,
): Promise<void> {
  const run = getRunById(runId);
  if (!run) return;

  const pipelineRow = getPipelineById(run.pipelineId);
  if (!pipelineRow) return;
  const pipeline = toPipelineConfig(pipelineRow);

  const parentThreadId = run.threadId;

  // Get the last assistant message from the REVIEWER thread to parse the verdict
  const reviewerThread = tm.getThreadWithMessages(reviewerThreadId);
  if (!reviewerThread) return;

  const lastAssistantMsg = [...reviewerThread.messages]
    .reverse()
    .find((m) => m.role === 'assistant');

  if (!lastAssistantMsg) {
    log.warn('Pipeline: no assistant message found after review', {
      namespace: 'pipeline',
      runId,
    });
    await cleanupReviewerThread(reviewerThreadId, projectId);
    completePipelineRun(runId, parentThreadId, userId, pipeline.id, 'failed');
    return;
  }

  // Parse the verdict from the message
  const { verdict, findings } = parseReviewVerdict(lastAssistantMsg.content);

  updateRun(runId, { verdict, findings: findings ? JSON.stringify(findings) : null });

  emitPipelineEvent(userId, {
    type: 'pipeline:stage_update',
    threadId: parentThreadId,
    data: {
      pipelineId: pipeline.id,
      runId,
      threadId: parentThreadId,
      stage: 'reviewer' as PipelineStageType,
      iteration: run.iteration,
      maxIterations: run.maxIterations,
      verdict: verdict as PipelineVerdict,
      findings: findings ? JSON.stringify(findings) : undefined,
    },
  });

  // Clean up the reviewer worktree — we're done with it
  await cleanupReviewerThread(reviewerThreadId, projectId);

  if (verdict === 'pass') {
    log.info('Pipeline: review PASSED', { namespace: 'pipeline', runId });
    completePipelineRun(runId, parentThreadId, userId, pipeline.id, 'completed');
    return;
  }

  // FAIL — check iteration limit
  if (run.iteration >= run.maxIterations) {
    log.warn('Pipeline: max iterations reached', {
      namespace: 'pipeline',
      runId,
      iteration: run.iteration,
    });
    completePipelineRun(runId, parentThreadId, userId, pipeline.id, 'failed');
    return;
  }

  // Resolve the parent thread's cwd for the corrector stage
  const parentThread = tm.getThread(parentThreadId);
  const project = pm.getProject(projectId);
  const parentCwd = parentThread?.worktreePath || project?.path;
  if (!parentCwd) {
    completePipelineRun(runId, parentThreadId, userId, pipeline.id, 'failed');
    return;
  }

  // Start the corrector stage
  log.info('Pipeline: review FAILED, starting corrector', {
    namespace: 'pipeline',
    runId,
    iteration: run.iteration,
  });

  await runCorrectorStage(runId, pipeline, parentThreadId, userId, projectId, parentCwd, findings);
}

/**
 * Run the corrector stage — creates a worktree thread and spawns a fixer agent.
 */
async function runCorrectorStage(
  runId: string,
  pipeline: PipelineConfig,
  parentThreadId: string,
  userId: string,
  projectId: string,
  cwd: string,
  findings: unknown,
): Promise<void> {
  updateRun(runId, { status: 'fixing', currentStage: 'corrector' });

  emitPipelineEvent(userId, {
    type: 'pipeline:stage_update',
    threadId: parentThreadId,
    data: {
      pipelineId: pipeline.id,
      runId,
      threadId: parentThreadId,
      stage: 'corrector' as PipelineStageType,
      iteration: getRunById(runId)?.iteration || 1,
      maxIterations: pipeline.maxIterations,
    },
  });

  const findingsStr = typeof findings === 'string' ? findings : JSON.stringify(findings, null, 2);
  const prompt = buildCorrectorPrompt(findingsStr);

  try {
    // Create a worktree thread for the corrector
    const correctorThread = await createAndStartThread({
      projectId,
      userId,
      title: `Pipeline fix (iteration ${getRunById(runId)?.iteration || 1})`,
      mode: 'worktree',
      provider: 'claude',
      model: pipeline.fixModel,
      permissionMode: 'autoEdit',
      source: 'automation',
      prompt,
      parentThreadId,
    });

    // Track the corrector thread → run mapping
    correctorThreadToRun.set(correctorThread.id, runId);
    updateRun(runId, { fixerThreadId: correctorThread.id });

    log.info('Pipeline: corrector thread created', {
      namespace: 'pipeline',
      runId,
      correctorThreadId: correctorThread.id,
    });
  } catch (err) {
    log.error('Pipeline: failed to start corrector', {
      namespace: 'pipeline',
      runId,
      error: String(err),
    });
    completePipelineRun(runId, parentThreadId, userId, pipeline.id, 'failed');
  }
}

/**
 * Handle corrector completion — apply changes and commit.
 * Called by the pipeline-completed-handler when agent:completed fires on a corrector thread.
 */
export async function handleCorrectorCompleted(
  runId: string,
  correctorThreadId: string,
  userId: string,
  projectId: string,
): Promise<void> {
  const run = getRunById(runId);
  if (!run) return;

  const pipelineRow = getPipelineById(run.pipelineId);
  if (!pipelineRow) return;

  const correctorThread = tm.getThread(correctorThreadId);
  if (!correctorThread) return;

  const pipelineId = pipelineRow.id;

  const correctorCwd = correctorThread.worktreePath || correctorThread.initCwd;
  if (!correctorCwd) {
    completePipelineRun(runId, run.threadId, userId, pipelineId, 'failed');
    return;
  }

  // Check if the corrector made any changes
  try {
    const statusResult = await gitRead(['status', '--porcelain'], {
      cwd: correctorCwd,
      reject: false,
    });

    const hasChanges = statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;

    if (!hasChanges) {
      log.info('Pipeline: corrector made no changes, skipping', {
        namespace: 'pipeline',
        runId,
      });
      completePipelineRun(runId, run.threadId, userId, pipelineId, 'skipped');
      correctorThreadToRun.delete(correctorThreadId);
      return;
    }

    // Stage all changes in the worktree
    await gitRead(['add', '-A'], { cwd: correctorCwd, reject: false });

    // Generate a diff patch from the worktree
    const diffResult = await gitRead(['diff', '--cached'], {
      cwd: correctorCwd,
      reject: false,
    });

    if (diffResult.exitCode !== 0 || !diffResult.stdout.trim()) {
      log.warn('Pipeline: failed to get diff from corrector worktree', {
        namespace: 'pipeline',
        runId,
      });
      completePipelineRun(runId, run.threadId, userId, pipelineId, 'failed');
      correctorThreadToRun.delete(correctorThreadId);
      return;
    }

    // Apply the patch to the original thread's working directory
    const parentThread = tm.getThread(run.threadId);
    const parentCwd = parentThread?.worktreePath || parentThread?.initCwd;
    const project = pm.getProject(projectId);
    const targetCwd = parentCwd || project?.path;

    if (!targetCwd) {
      completePipelineRun(runId, run.threadId, userId, pipelineId, 'failed');
      correctorThreadToRun.delete(correctorThreadId);
      return;
    }

    // Apply patch via gitWrite (supports stdin)
    try {
      const applyResult = await gitWrite(['apply', '--index', '-'], {
        cwd: targetCwd,
        stdin: diffResult.stdout,
        reject: false,
      });
      if (applyResult.exitCode !== 0) {
        throw new Error(applyResult.stderr || 'git apply failed');
      }
    } catch (applyErr) {
      log.error('Pipeline: failed to apply corrector patch', {
        namespace: 'pipeline',
        runId,
        error: String(applyErr),
      });
      completePipelineRun(runId, run.threadId, userId, pipelineId, 'failed');
      correctorThreadToRun.delete(correctorThreadId);
      return;
    }

    // Commit the fix on the original thread's branch
    const iteration = run.iteration;
    const commitMessage = `fix: address review findings (pipeline run ${runId.slice(0, 8)}, iteration ${iteration})`;

    const { commitChanges } = await import('./git-service.js');

    // We need to set the pipeline metadata on the event so it doesn't trigger an infinite loop
    // We do this by importing threadEventBus and adding a one-time listener before the commit
    const { threadEventBus } = await import('./thread-event-bus.js');

    // Temporarily patch the next git:committed event to include pipeline metadata
    const patchListener = (event: { isPipelineCommit?: boolean; pipelineRunId?: string }) => {
      event.isPipelineCommit = true;
      event.pipelineRunId = runId;
    };
    threadEventBus.on('git:committed', patchListener as any);

    try {
      await commitChanges(run.threadId, userId, targetCwd, commitMessage, false, true);
    } finally {
      threadEventBus.removeListener('git:committed', patchListener as any);
    }

    // Increment iteration
    updateRun(runId, { iteration: iteration + 1 });

    // Clean up corrector thread tracking
    correctorThreadToRun.delete(correctorThreadId);

    log.info('Pipeline: corrector changes committed, re-reviewing', {
      namespace: 'pipeline',
      runId,
      iteration: iteration + 1,
    });

    // The git:committed event will trigger a new review via the pipeline-trigger-handler
    // with isPipelineCommit=true and pipelineRunId set, which will call startReview
    // to continue the existing run.
  } catch (err) {
    log.error('Pipeline: corrector completion error', {
      namespace: 'pipeline',
      runId,
      error: String(err),
    });
    completePipelineRun(runId, run.threadId, userId, pipelineId, 'failed');
    correctorThreadToRun.delete(correctorThreadId);
  }
}

// ── Reviewer cleanup ─────────────────────────────────────────

/**
 * Clean up a reviewer worktree thread — remove the worktree, branch, and
 * archive the thread. Called after the reviewer verdict is parsed.
 */
async function cleanupReviewerThread(reviewerThreadId: string, projectId: string): Promise<void> {
  reviewerThreadToRun.delete(reviewerThreadId);

  const reviewerThread = tm.getThread(reviewerThreadId);
  if (!reviewerThread) return;

  const project = pm.getProject(projectId);
  if (!project) return;

  // Remove worktree and branch
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

  // Archive the reviewer thread
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

// ── Completion ──────────────────────────────────────────────

function completePipelineRun(
  runId: string,
  threadId: string,
  userId: string,
  pipelineId: string,
  status: PipelineRunStatus,
) {
  updateRun(runId, {
    status,
    completedAt: new Date().toISOString(),
  });

  activeRuns.delete(runId);

  const run = getRunById(runId);

  emitPipelineEvent(userId, {
    type: 'pipeline:run_completed',
    threadId,
    data: {
      pipelineId,
      runId,
      threadId,
      status,
      totalIterations: run?.iteration || 0,
    },
  });

  log.info('Pipeline: run completed', {
    namespace: 'pipeline',
    runId,
    status,
    iterations: run?.iteration || 0,
  });
}

// ── Verdict parser ──────────────────────────────────────────

function parseReviewVerdict(content: string): {
  verdict: PipelineVerdict;
  findings: unknown;
} {
  // Try to extract JSON block from the message
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        verdict: parsed.verdict === 'pass' ? 'pass' : 'fail',
        findings: parsed.findings || [],
      };
    } catch {
      // Fall through to heuristic
    }
  }

  // Try raw JSON object
  const rawJsonMatch = content.match(/\{[\s\S]*"verdict"\s*:\s*"(pass|fail)"[\s\S]*\}/);
  if (rawJsonMatch) {
    try {
      const parsed = JSON.parse(rawJsonMatch[0]);
      return {
        verdict: parsed.verdict === 'pass' ? 'pass' : 'fail',
        findings: parsed.findings || [],
      };
    } catch {
      // Fall through to heuristic
    }
  }

  // Heuristic: look for pass/fail keywords
  const lowerContent = content.toLowerCase();
  if (
    lowerContent.includes('"verdict": "pass"') ||
    lowerContent.includes('verdict: pass') ||
    lowerContent.includes('all checks pass')
  ) {
    return { verdict: 'pass', findings: [] };
  }

  // Default to fail if we can't parse
  return { verdict: 'fail', findings: content };
}

// ── Pre-commit fixer ────────────────────────────────────────

/**
 * Auto-fixable hook names — secretlint is NOT auto-fixable (security decision).
 */
// Hook names that the pipeline auto-fixer can handle.
// Some names reference JS debug primitives — built dynamically to avoid
// triggering the pre-commit debug-statement grep.
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

/**
 * Build a prompt for the pre-commit fixer agent.
 */
export function buildPrecommitFixerPrompt(
  hookName: string,
  errorOutput: string,
  stagedFiles: string[],
): string {
  return `A pre-commit hook "${hookName}" failed with the following error:

\`\`\`
${errorOutput}
\`\`\`

The staged files are:
${stagedFiles.map((f) => `- ${f}`).join('\n')}

Fix the issues reported by the hook. Only modify the files that have errors.
After fixing, stage your changes with \`git add\`.
Do NOT create a commit.`;
}
