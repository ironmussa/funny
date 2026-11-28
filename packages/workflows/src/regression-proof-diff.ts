/**
 * Pure check that a generated workflow YAML differs from its starting workflow
 * YAML *only* in the `regression_proof` configuration of existing
 * `regression_proof` steps (openspec factory-flow-bootstrap, D4 / Task 3.2).
 *
 * Compares the parsed documents rather than raw text so harmless YAML
 * formatting/comment differences are allowed while any semantic change outside
 * `regression_proof` (removing/adding/reordering steps, editing prompts,
 * changing `merge` options, changing triggers/inputs, etc.) is refused.
 */

import { isDeepStrictEqual } from 'node:util';

import { isMap, isSeq, parseDocument, YAMLMap } from 'yaml';

import { parseWorkflowYaml, type ParseError } from './parse.js';
import type { ParsedNode, ParsedWorkflow } from './schema.js';

export type RegressionProofDiffResult =
  | { ok: true; starting: ParsedWorkflow; candidate: ParsedWorkflow }
  | {
      ok: false;
      reason: 'starting-invalid' | 'candidate-invalid' | 'changed-outside-regression-proof';
      message: string;
      differences: string[];
      parseError?: ParseError;
    };

function stripRegressionProof(node: ParsedNode): Omit<ParsedNode, 'regression_proof'> {
  const { regression_proof: _omitted, ...rest } = node;
  return rest;
}

function stripNodes(workflow: ParsedWorkflow): Omit<ParsedWorkflow, 'nodes'> {
  const { nodes: _omitted, ...rest } = workflow;
  return rest;
}

function diffEntries(
  aEntries: Array<[string, unknown]>,
  bEntries: Array<[string, unknown]>,
): string[] {
  const aMap = new Map(aEntries);
  const bMap = new Map(bEntries);
  const keys = new Set([...aMap.keys(), ...bMap.keys()]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    if (!isDeepStrictEqual(aMap.get(key), bMap.get(key))) {
      changed.push(key);
    }
  }
  return changed;
}

function diffWorkflowsOutsideRegressionProof(
  starting: ParsedWorkflow,
  candidate: ParsedWorkflow,
): string[] {
  const diffs: string[] = [];

  // Compare all top-level keys except `nodes`.
  for (const key of diffEntries(
    Object.entries(stripNodes(starting)),
    Object.entries(stripNodes(candidate)),
  )) {
    diffs.push(`top-level field "${key}" changed`);
  }

  // Compare nodes in order by id and content.
  const startingIds = starting.nodes.map((n) => n.id);
  const candidateIds = candidate.nodes.map((n) => n.id);

  const startingSet = new Set(startingIds);
  const candidateSet = new Set(candidateIds);
  for (const id of startingIds) {
    if (!candidateSet.has(id)) diffs.push(`step "${id}" was removed`);
  }
  for (const id of candidateIds) {
    if (!startingSet.has(id)) diffs.push(`step "${id}" was added`);
  }

  if (diffs.length === 0 && !isDeepStrictEqual(startingIds, candidateIds)) {
    diffs.push('step order changed');
  }

  // Compare each matching node by id.
  const candidateById = new Map(candidate.nodes.map((n) => [n.id, n]));
  for (const startNode of starting.nodes) {
    const candNode = candidateById.get(startNode.id);
    if (!candNode) continue;

    const startHasProof = startNode.regression_proof !== undefined;
    const candHasProof = candNode.regression_proof !== undefined;

    if (startHasProof && !candHasProof) {
      diffs.push(`step "${startNode.id}" removed its regression_proof action`);
      continue;
    }
    if (!startHasProof && candHasProof) {
      diffs.push(`step "${startNode.id}" changed its action to regression_proof`);
      continue;
    }

    if (startHasProof) {
      // Only `regression_proof` may differ on this node.
      for (const key of diffEntries(
        Object.entries(stripRegressionProof(startNode)),
        Object.entries(stripRegressionProof(candNode)),
      )) {
        diffs.push(`step "${startNode.id}" changed field "${key}" outside regression_proof`);
      }
    } else if (!isDeepStrictEqual(startNode, candNode)) {
      for (const key of diffEntries(Object.entries(startNode), Object.entries(candNode))) {
        diffs.push(`step "${startNode.id}" changed field "${key}"`);
      }
    }
  }

  return diffs;
}

/**
 * Verify that `candidateYaml` parses cleanly and differs from `startingYaml`
 * only in the `regression_proof` block of existing `regression_proof` steps.
 */
export function checkOnlyRegressionProofChanged(
  startingYaml: string,
  candidateYaml: string,
): RegressionProofDiffResult {
  const startingParsed = parseWorkflowYaml(startingYaml, 'starting-workflow');
  if (!startingParsed.ok) {
    return {
      ok: false,
      reason: 'starting-invalid',
      message: startingParsed.error.message,
      differences: [],
      parseError: startingParsed.error,
    };
  }

  const candidateParsed = parseWorkflowYaml(candidateYaml, 'candidate-workflow');
  if (!candidateParsed.ok) {
    return {
      ok: false,
      reason: 'candidate-invalid',
      message: candidateParsed.error.message,
      differences: [],
      parseError: candidateParsed.error,
    };
  }

  const differences = diffWorkflowsOutsideRegressionProof(
    startingParsed.workflow,
    candidateParsed.workflow,
  );
  if (differences.length > 0) {
    return {
      ok: false,
      reason: 'changed-outside-regression-proof',
      message: `Flow file changes more than regression_proof: ${differences.join('; ')}`,
      differences,
    };
  }

  return {
    ok: true,
    starting: startingParsed.workflow,
    candidate: candidateParsed.workflow,
  };
}

/**
 * Return `workflowYaml` with `regression_proof.rules` pruned to only the rule
 * indices in `acceptedIndices`, preserving comments and formatting everywhere
 * else in the YAML document.
 */
export function pruneRegressionProofRules(
  workflowYaml: string,
  acceptedIndices: ReadonlySet<number>,
): string {
  const doc = parseDocument(workflowYaml);
  const nodes = doc.get('nodes', true);
  if (!isSeq(nodes)) return doc.toString();

  let globalIndex = 0;
  for (const item of nodes.items) {
    if (!isMap(item)) continue;
    const proof = item.get('regression_proof', true);
    if (!isMap(proof)) continue;
    const rules = proof.get('rules', true);
    if (!isSeq(rules)) continue;

    const kept = [];
    for (const ruleItem of rules.items) {
      if (acceptedIndices.has(globalIndex)) {
        kept.push(ruleItem);
      }
      globalIndex++;
    }
    rules.items = kept;
  }

  return doc.toString();
}

/**
 * Return `startingYaml` with `require_regression_proof: false` set on every
 * `merge` step, preserving comments and formatting everywhere else.
 */
export function buildOptOutWorkflowYaml(startingYaml: string): string {
  const doc = parseDocument(startingYaml);
  const nodes = doc.get('nodes', true);
  if (!isSeq(nodes)) return doc.toString();

  for (const item of nodes.items) {
    if (!isMap(item)) continue;
    if (!item.has('merge')) continue;
    const mergeNode = item.get('merge', true);
    if (isMap(mergeNode)) {
      mergeNode.set('require_regression_proof', false);
    } else {
      const map = new YAMLMap();
      map.set('require_regression_proof', false);
      item.set('merge', map);
    }
  }

  return doc.toString();
}
