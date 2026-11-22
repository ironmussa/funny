/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: core
 * @domain type: pipeline-definitions
 * @domain layer: application
 *
 * Composable pipeline definitions for all git workflow actions.
 *
 * Each action (commit, push, merge, etc.) is a pipeline composed from
 * reusable node groups, each in its own module under `git-pipelines/`:
 *   - stageNodes:     unstage → stage                       (stage-commit-nodes.ts)
 *   - commitNodes:    hooks (with auto-fix) → commit        (stage-commit-nodes.ts, precommit-autofix.ts)
 *   - review-fix:     review → fix → apply-patch → commit-fix (loop) (review-fix.ts)
 *   - test-fix:       test-run → test-fixer (loop)          (test-fix.ts)
 *   - pushNodes / prNodes / mergeNodes                      (publish-nodes.ts)
 *
 * The commit pipeline includes the full flow:
 *   unstage? → stage? → hooks → commit → review → fix (loop) → tests (loop)
 */
import {
  compose,
  definePipeline,
  subPipeline,
  type PipelineDefinition,
  type PipelineNode,
} from '@funny/pipelines';
import type { GitWorkflowAction } from '@funny/shared';

import type { GitPipelineContext } from './git-pipelines/context.js';
import { mergeNodes, prNodes, pushNodes } from './git-pipelines/publish-nodes.js';
import { reviewFixSubPipeline } from './git-pipelines/review-fix.js';
import { commitNodes, stageNodes } from './git-pipelines/stage-commit-nodes.js';
import { testFixSubPipeline } from './git-pipelines/test-fix.js';

export type { GitPipelineContext } from './git-pipelines/context.js';
export { deriveSteps } from './git-pipelines/steps.js';

// ── Pipeline definitions (one per action) ────────────────────

/** Shared review-fix sub-pipeline node — used by all commit-based pipelines. */
const reviewFixNode = subPipeline('review-fix', reviewFixSubPipeline, {
  when: (ctx) => ctx.pipelineEnabled && !!ctx.threadId && !!ctx.projectId,
});

/** Shared test-fix sub-pipeline node — runs after review-fix. */
const testFixNode = subPipeline('test-fix', testFixSubPipeline, {
  when: (ctx) => ctx.testEnabled && !!ctx.testCommand && !!ctx.threadId && !!ctx.projectId,
});

/** Build a commit-based pipeline: stage → commit → review-fix → test-fix → ...tail */
function commitPipelineWith(name: string, ...tail: PipelineNode<GitPipelineContext>[][]) {
  return definePipeline<GitPipelineContext>({
    name,
    nodes: compose(stageNodes, commitNodes, [reviewFixNode], [testFixNode], ...tail),
  });
}

const commitPipeline = commitPipelineWith('git:commit');
const commitPushPipeline = commitPipelineWith('git:commit-push', pushNodes);
const commitPrPipeline = commitPipelineWith('git:commit-pr', pushNodes, prNodes);
const commitMergePipeline = commitPipelineWith('git:commit-merge', mergeNodes);

const pushPipeline = definePipeline<GitPipelineContext>({
  name: 'git:push',
  nodes: pushNodes,
});

const mergePipeline = definePipeline<GitPipelineContext>({
  name: 'git:merge',
  nodes: mergeNodes,
});

const createPrPipeline = definePipeline<GitPipelineContext>({
  name: 'git:create-pr',
  nodes: compose(pushNodes, prNodes),
});

/** Get the pipeline definition for a given action. */
export function getActionPipeline(
  action: GitWorkflowAction,
): PipelineDefinition<GitPipelineContext> {
  switch (action) {
    case 'commit':
    case 'amend':
      return commitPipeline;
    case 'commit-push':
      return commitPushPipeline;
    case 'commit-pr':
      return commitPrPipeline;
    case 'commit-merge':
      return commitMergePipeline;
    case 'push':
      return pushPipeline;
    case 'merge':
      return mergePipeline;
    case 'create-pr':
      return createPrPipeline;
  }
}

// ── Step derivation ──────────────────────────────────────────
