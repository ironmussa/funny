/**
 * Warnings of a workflow the schema accepted: things that load and run but
 * probably do not do what the author meant. A warning never fails the parse.
 */

import type { WorkflowIssue } from './parse.js';

/** The parts of a workflow the warnings read. */
interface WarnedWorkflow {
  nodes: ReadonlyArray<{
    id: string;
    depends_on: string[];
    trigger_rule?: string;
    on_error?: string;
    merge?: { require_regression_proof?: boolean; require_review?: boolean };
    regression_proof?: { rules?: unknown[] };
    review?: object;
  }>;
}

/** Every warning of the workflow, in node order. */
export function workflowWarnings(workflow: WarnedWorkflow): WorkflowIssue[] {
  return [
    ...continuedFailureSkips(workflow),
    ...regressionProofWarnings(workflow),
    ...mergeWithoutReview(workflow),
  ];
}

/**
 * A `merge` that needs a review (the default) in a flow with no `review`
 * step: no commit ever gets a verdict, so every run stops at the merge and
 * waits for a person.
 */
function mergeWithoutReview(workflow: WarnedWorkflow): WorkflowIssue[] {
  if (workflow.nodes.some((n) => n.review !== undefined)) return [];
  return workflow.nodes.flatMap((n, index) =>
    n.merge && n.merge.require_review !== false
      ? [
          {
            path: `nodes.${index}.merge`,
            message:
              `"${n.id}" needs a passing review of the commit it merges, and this flow has no review step. ` +
              'Every run will wait for a person at the merge. Add a review step before it, ' +
              'or set require_review: false on the merge.',
          },
        ]
      : [],
  );
}

function regressionProofWarnings(workflow: WarnedWorkflow): WorkflowIssue[] {
  return [...proofOptOuts(workflow), ...proofWithoutRules(workflow)];
}

/** A `merge` that opts out of the regression proof gate. */
function proofOptOuts(workflow: WarnedWorkflow): WorkflowIssue[] {
  return workflow.nodes.flatMap((n, index) =>
    n.merge?.require_regression_proof === false
      ? [
          {
            path: `nodes.${index}.merge.require_regression_proof`,
            message:
              `"${n.id}" opts out of the regression proof gate. ` +
              'Runs of this flow can merge without proving their tests catch the bug.',
          },
        ]
      : [],
  );
}

/** A gated `merge` whose flow has a `regression_proof` step with no rules. */
function proofWithoutRules(workflow: WarnedWorkflow): WorkflowIssue[] {
  const gated = workflow.nodes.some((n) => n.merge && n.merge.require_regression_proof !== false);
  if (!gated) return [];
  const index = workflow.nodes.findIndex((n) => n.regression_proof !== undefined);
  const rules = workflow.nodes[index]?.regression_proof?.rules ?? [];
  if (index < 0 || rules.length > 0) return [];
  return [
    {
      path: `nodes.${index}.regression_proof`,
      message:
        'This flow has a regression_proof step with no rules. ' +
        'Its factory will not admit issues until rules are added or ' +
        'merge sets require_regression_proof: false.',
    },
  ];
}

/**
 * A node that fails with `on_error: continue` is marked failed, so a
 * dependent on the default join (`all_success`) is skipped. Before the
 * graph engine the failure was swallowed and the dependent ran; warn the
 * dependents that did not choose a join. Any explicit `trigger_rule`
 * (even `all_success`) is a choice and silences the warning.
 */
function continuedFailureSkips(workflow: WarnedWorkflow): WorkflowIssue[] {
  const continues = new Set(
    workflow.nodes.filter((n) => n.on_error === 'continue').map((n) => n.id),
  );
  if (continues.size === 0) return [];
  return workflow.nodes.flatMap((n, index) => {
    if (n.trigger_rule !== undefined) return [];
    const deps = n.depends_on.filter((dep) => continues.has(dep));
    if (deps.length === 0) return [];
    const names = deps.map((dep) => `"${dep}"`).join(', ');
    const verb = deps.length === 1 ? 'fails' : 'fail';
    return [
      {
        path: `nodes.${index}.trigger_rule`,
        message:
          `"${n.id}" is skipped if ${names} ${verb} (on_error: continue). ` +
          'Add `trigger_rule: all_done` if it must run anyway.',
      },
    ];
  });
}
