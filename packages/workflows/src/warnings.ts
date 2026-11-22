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
    merge?: { require_regression_proof?: boolean };
    regression_proof?: { rules?: unknown[] };
  }>;
}

/** Every warning of the workflow, in node order. */
export function workflowWarnings(workflow: WarnedWorkflow): WorkflowIssue[] {
  return [...continuedFailureSkips(workflow), ...regressionProofWarnings(workflow)];
}

/**
 * A node that fails with `on_error: continue` is marked failed, so a
 * dependent on the default join (`all_success`) is skipped. Before the
 * graph engine the failure was swallowed and the dependent ran; warn the
 * dependents that did not choose a join. Any explicit `trigger_rule`
 * (even `all_success`) is a choice and silences the warning.
 */
function regressionProofWarnings(workflow: WarnedWorkflow): WorkflowIssue[] {
  const warnings: WorkflowIssue[] = [];
  for (const [index, n] of workflow.nodes.entries()) {
    if (n.merge?.require_regression_proof === false) {
      warnings.push({
        path: `nodes.${index}.merge.require_regression_proof`,
        message:
          `"${n.id}" opts out of the regression proof gate. ` +
          'Runs of this flow can merge without proving their tests catch the bug.',
      });
    }
  }

  const mergeNode = workflow.nodes.find((n) => n.merge !== undefined);
  if (mergeNode && mergeNode.merge!.require_regression_proof !== false) {
    const proofNode = workflow.nodes.find((n) => n.regression_proof !== undefined);
    if (proofNode && (proofNode.regression_proof!.rules?.length ?? 0) === 0) {
      const idx = workflow.nodes.indexOf(proofNode);
      warnings.push({
        path: `nodes.${idx}.regression_proof`,
        message:
          'This flow has a regression_proof step with no rules. ' +
          'Its factory will not admit issues until rules are added or ' +
          'merge sets require_regression_proof: false.',
      });
    }
  }

  return warnings;
}

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
