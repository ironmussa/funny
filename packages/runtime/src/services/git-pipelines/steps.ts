/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: core
 * @domain type: pipeline-helpers
 * @domain layer: application
 *
 * Derives a git workflow's progress steps from its pipeline definition.
 */
import type { PipelineDefinition } from '@funny/pipelines';
import type { GitWorkflowProgressStep } from '@funny/shared';

import type { GitPipelineContext } from './context.js';
import { reviewFixSubPipeline } from './review-fix.js';
import { testFixSubPipeline } from './test-fix.js';

/** Human-readable labels for each pipeline node, keyed by node name. */
const STEP_LABELS = new Map(
  Object.entries({
    unstage: 'Unstaging files',
    stage: 'Staging files',
    hooks: 'Running pre-commit hooks',
    commit: 'Committing',
    review: 'Reviewing code',
    fix: 'Fixing issues',
    'test-run': 'Running tests',
    'test-fixer': 'Fixing test failures',
    push: 'Pushing',
    pr: 'Creating pull request',
    merge: 'Merging',
  }),
);

/**
 * Derive the progress steps array by walking the pipeline's node list
 * and evaluating guards against the initial context. This replaces the
 * hand-built `buildSteps()` that duplicated pipeline composition logic.
 *
 * Sub-pipeline nodes (e.g. review-fix) are expanded into their child nodes.
 */
export function deriveSteps(
  pipeline: PipelineDefinition<GitPipelineContext>,
  ctx: GitPipelineContext,
): GitWorkflowProgressStep[] {
  const steps: GitWorkflowProgressStep[] = [];

  for (const n of pipeline.nodes) {
    // Skip guarded-out nodes
    if (n.when && !n.when(ctx)) continue;

    // Expand the review-fix sub-pipeline into its visible child nodes.
    // Guards on child nodes are NOT evaluated here — they depend on runtime
    // state (e.g. verdict), not on the initial context. We show only the
    // user-facing steps (review + fix), skipping internal ones (apply-patch,
    // commit-fix) that don't have UI labels.
    if (n.name === 'review-fix') {
      for (const child of reviewFixSubPipeline.nodes) {
        const label = STEP_LABELS.get(child.name);
        if (!label) continue; // skip internal nodes without UI labels
        steps.push({ id: child.name, label, status: 'pending' });
      }
      continue;
    }

    if (n.name === 'test-fix') {
      for (const child of testFixSubPipeline.nodes) {
        const label = STEP_LABELS.get(child.name);
        if (!label) continue;
        steps.push({ id: child.name, label, status: 'pending' });
      }
      continue;
    }

    const step: GitWorkflowProgressStep = {
      id: n.name,
      label:
        n.name === 'commit' && ctx.action === 'amend'
          ? 'Amending commit'
          : (STEP_LABELS.get(n.name) ?? n.name),
      status: 'pending',
    };

    // Add hook sub-items if this is the hooks step
    if (n.name === 'hooks' && ctx.hooks.length > 0) {
      step.subItems = ctx.hooks.map((h) => ({
        label: h.label,
        status: 'pending' as const,
      }));
    }

    steps.push(step);
  }

  return steps;
}
