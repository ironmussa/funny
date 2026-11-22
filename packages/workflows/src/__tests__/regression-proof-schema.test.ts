/**
 * Schema and validation tests for the regression_proof action and the
 * require_regression_proof option on merge.
 */

import { describe, expect, test } from 'bun:test';

import { parseWorkflowYaml } from '../parse.js';
import { isProofReady } from '../schema.js';

function flow(proofYaml: string, mergeYaml = 'merge: { method: squash }') {
  return `
name: test-flow
nodes:
  - id: implement
    spawn_agent: { prompt: do it }
  - id: pull-request
    depends_on: [implement]
    create_pr: { title: fix }
  - id: proof
    depends_on: [pull-request]
${proofYaml}
  - id: ci
    depends_on: [proof]
    wait_ci: {}
  - id: merge
    depends_on: [ci]
    ${mergeYaml}
`.trim();
}

function parse(yaml: string) {
  const result = parseWorkflowYaml(yaml);
  if (!result.ok) throw new Error(`expected valid: ${result.error.message}`);
  return result;
}

function parseErr(yaml: string) {
  const result = parseWorkflowYaml(yaml);
  if (result.ok) throw new Error('expected invalid');
  return result.error;
}

describe('regression_proof schema', () => {
  test('exempt labels and a setup command parse; an empty setup command does not', () => {
    const result = parse(
      flow(`    regression_proof:
      rules:
        - globs: ['**/*.test.ts']
          command: 'bun test {{files}}'
      require_test: always
      exempt_labels: [docs, chore]
      setup_command: 'bun install --frozen-lockfile'`),
    );
    const proof = result.workflow.nodes.find((n) => n.regression_proof)?.regression_proof;
    expect(proof?.exempt_labels).toEqual(['docs', 'chore']);
    expect(proof?.setup_command).toBe('bun install --frozen-lockfile');
    parseErr(
      flow(`    regression_proof:
      rules: []
      setup_command: ''`),
    );
  });

  test('a valid regression_proof step with rules parses', () => {
    const result = parse(
      flow(`    regression_proof:
      rules:
        - globs: ['**/*.test.ts']
          command: 'bun test {{files}}'
      support_globs: ['**/__fixtures__/**']
      require_test: labels
      labels: [bug]
      timeout_ms: 600000`),
    );
    const proofNode = result.workflow.nodes.find((n) => n.regression_proof);
    expect(proofNode?.regression_proof?.rules).toHaveLength(1);
    expect(proofNode?.regression_proof?.rules[0].command).toBe('bun test {{files}}');
    expect(proofNode?.regression_proof?.support_globs).toEqual(['**/__fixtures__/**']);
  });

  test('a regression_proof step with no rules (empty) parses', () => {
    const result = parse(flow('    regression_proof: { rules: [] }'));
    const proofNode = result.workflow.nodes.find((n) => n.regression_proof);
    expect(proofNode?.regression_proof?.rules).toEqual([]);
  });

  test('a regression_proof step with no rules (omitted) parses with default empty', () => {
    const result = parse(flow('    regression_proof: {}'));
    const proofNode = result.workflow.nodes.find((n) => n.regression_proof);
    expect(proofNode?.regression_proof?.rules).toEqual([]);
  });

  test('two rules with different cwd parse', () => {
    const result = parse(
      flow(`    regression_proof:
      rules:
        - globs: ['packages/client/**/*.test.ts']
          cwd: packages/client
          command: 'bun test --isolate {{files}}'
        - globs: ['**/*.test.ts']
          command: 'bun test {{files}}'`),
    );
    const rules = result.workflow.nodes.find((n) => n.regression_proof)?.regression_proof?.rules;
    expect(rules).toHaveLength(2);
    expect(rules![0].cwd).toBe('packages/client');
    expect(rules![1].cwd).toBeUndefined();
  });

  test('a rule whose command has no {{files}} is refused', () => {
    const error = parseErr(
      flow(`    regression_proof:
      rules:
        - globs: ['**/*.test.ts']
          command: 'bun test'`),
    );
    expect(error.issues.some((i) => i.message.includes('{{files}}'))).toBe(true);
  });

  test('a rule whose cwd contains .. is refused', () => {
    const error = parseErr(
      flow(`    regression_proof:
      rules:
        - globs: ['**/*.test.ts']
          command: 'bun test {{files}}'
          cwd: '../outside'`),
    );
    expect(error.issues.some((i) => i.message.includes('path traversal'))).toBe(true);
  });
});

describe('require_regression_proof on merge', () => {
  test('defaults to undefined (treated as true by the runtime)', () => {
    const result = parse(flow('    regression_proof: {}'));
    const mergeNode = result.workflow.nodes.find((n) => n.merge);
    expect(mergeNode?.merge?.require_regression_proof).toBeUndefined();
  });

  test('can be set to false', () => {
    const result = parse(
      flow(
        '    regression_proof: {}',
        'merge: { method: squash, require_regression_proof: false }',
      ),
    );
    const mergeNode = result.workflow.nodes.find((n) => n.merge);
    expect(mergeNode?.merge?.require_regression_proof).toBe(false);
  });

  test('require_regression_proof: false produces a warning', () => {
    const result = parse(
      flow(
        '    regression_proof: {}',
        'merge: { method: squash, require_regression_proof: false }',
      ),
    );
    expect(result.warnings.some((w) => w.message.includes('opts out'))).toBe(true);
  });
});

describe('isProofReady', () => {
  test('a flow with no merge step is proof-ready', () => {
    const result = parseWorkflowYaml(
      `
name: no-merge
nodes:
  - id: implement
    spawn_agent: { prompt: do it }
`.trim(),
    );
    expect(result.ok && isProofReady(result.workflow)).toBe(true);
  });

  test('a flow with merge opt-out is proof-ready', () => {
    const result = parse(
      flow(
        '    regression_proof: {}',
        'merge: { method: squash, require_regression_proof: false }',
      ),
    );
    expect(isProofReady(result.workflow)).toBe(true);
  });

  test('a flow with merge and rules is proof-ready', () => {
    const result = parse(
      flow(`    regression_proof:
      rules:
        - globs: ['**/*.test.ts']
          command: 'bun test {{files}}'`),
    );
    expect(isProofReady(result.workflow)).toBe(true);
  });

  test('a flow with merge, proof step, but no rules is NOT proof-ready', () => {
    const result = parse(flow('    regression_proof: {}'));
    expect(isProofReady(result.workflow)).toBe(false);
  });

  test('a flow with merge but no proof step is NOT proof-ready', () => {
    const result = parseWorkflowYaml(
      `
name: no-proof
nodes:
  - id: implement
    spawn_agent: { prompt: do it }
  - id: merge
    depends_on: [implement]
    merge: { method: squash }
`.trim(),
    );
    expect(result.ok && isProofReady(result.workflow)).toBe(false);
  });
});

describe('warnings for not-proof-ready', () => {
  test('a proof step with empty rules warns', () => {
    const result = parse(flow('    regression_proof: {}'));
    expect(result.warnings.some((w) => w.message.includes('no rules'))).toBe(true);
  });

  test('a proof step with rules does not warn', () => {
    const result = parse(
      flow(`    regression_proof:
      rules:
        - globs: ['**/*.test.ts']
          command: 'bun test {{files}}'`),
    );
    expect(result.warnings.filter((w) => w.message.includes('no rules'))).toEqual([]);
  });
});
