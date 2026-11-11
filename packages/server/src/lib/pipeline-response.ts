/**
 * `pipelines` / `pipeline_runs` rows → the types the HTTP contract declares
 * (`@funny/shared/contracts/pipelines`): booleans instead of 0/1 flags and
 * absent optional fields instead of null.
 */

import type {
  AgentModel,
  Pipeline,
  PipelineRun,
  PipelineRunStatus,
  PipelineStageType,
  PipelineVerdict,
} from '@funny/shared';

import type { pipelineRuns, pipelines } from '../db/schema.js';

type PipelineRow = typeof pipelines.$inferSelect;
type PipelineRunRow = typeof pipelineRuns.$inferSelect;

export function toPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    enabled: row.enabled === 1,
    reviewModel: row.reviewModel as AgentModel,
    fixModel: row.fixModel as AgentModel,
    maxIterations: row.maxIterations,
    precommitFixEnabled: row.precommitFixEnabled === 1,
    precommitFixModel: row.precommitFixModel as AgentModel,
    precommitFixMaxIterations: row.precommitFixMaxIterations,
    reviewerPrompt: row.reviewerPrompt ?? undefined,
    correctorPrompt: row.correctorPrompt ?? undefined,
    precommitFixerPrompt: row.precommitFixerPrompt ?? undefined,
    commitMessagePrompt: row.commitMessagePrompt ?? undefined,
    testEnabled: row.testEnabled === 1,
    testCommand: row.testCommand ?? undefined,
    testFixEnabled: row.testFixEnabled === 1,
    testFixModel: row.testFixModel as AgentModel,
    testFixMaxIterations: row.testFixMaxIterations,
    testFixerPrompt: row.testFixerPrompt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPipelineRun(row: PipelineRunRow): PipelineRun {
  return {
    id: row.id,
    pipelineId: row.pipelineId,
    threadId: row.threadId,
    status: row.status as PipelineRunStatus,
    currentStage: row.currentStage as PipelineStageType,
    iteration: row.iteration,
    maxIterations: row.maxIterations,
    commitSha: row.commitSha ?? undefined,
    verdict: (row.verdict ?? undefined) as PipelineVerdict | undefined,
    findings: row.findings ?? undefined,
    reviewerThreadId: row.reviewerThreadId ?? undefined,
    fixerThreadId: row.fixerThreadId ?? undefined,
    precommitIteration: row.precommitIteration ?? undefined,
    hookName: row.hookName ?? undefined,
    hookError: row.hookError ?? undefined,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
  };
}
