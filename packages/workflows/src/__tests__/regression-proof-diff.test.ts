import { describe, expect, test } from 'vitest';

import { parseWorkflowYaml } from '../parse.js';
import {
  buildOptOutWorkflowYaml,
  checkOnlyRegressionProofChanged,
  pruneRegressionProofRules,
} from '../regression-proof-diff.js';
import { isProofReady } from '../schema.js';

const BASE_FLOW = `
name: issue-to-merge
nodes:
  - id: implement
    spawn_agent:
      prompt: "Implement the fix."
  - id: proof
    depends_on: [implement]
    regression_proof:
      rules: []
  - id: review
    depends_on: [proof]
    review:
      early: true
  - id: merge
    depends_on: [review]
    merge:
      method: squash
      delete_branch: true
`;

describe('checkOnlyRegressionProofChanged', () => {
  test('accepts a file that only changes regression_proof', () => {
    const candidate = `
name: issue-to-merge
nodes:
  - id: implement
    spawn_agent:
      prompt: "Implement the fix."
  - id: proof
    depends_on: [implement]
    regression_proof:
      setup_command: "pnpm install --frozen-lockfile"
      support_globs: ["tests/helpers/**"]
      rules:
        - globs: ["**/*.spec.ts"]
          command: "pnpm exec jest {{files}}"
  - id: review
    depends_on: [proof]
    review:
      early: true
  - id: merge
    depends_on: [review]
    merge:
      method: squash
      delete_branch: true
`;
    const result = checkOnlyRegressionProofChanged(BASE_FLOW, candidate);
    expect(result.ok).toBe(true);
  });

  test('rejects a file that removes a step', () => {
    const candidate = `
name: issue-to-merge
nodes:
  - id: implement
    spawn_agent:
      prompt: "Implement the fix."
  - id: proof
    depends_on: [implement]
    regression_proof:
      rules:
        - globs: ["**/*.spec.ts"]
          command: "pnpm exec jest {{files}}"
  - id: merge
    depends_on: [proof]
    merge:
      method: squash
      delete_branch: true
`;
    const result = checkOnlyRegressionProofChanged(BASE_FLOW, candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('changed-outside-regression-proof');
      expect(result.differences.some((d) => d.includes('review'))).toBe(true);
    }
  });

  test('rejects a file that changes a prompt', () => {
    const candidate = BASE_FLOW.replace('Implement the fix.', 'Implement the fix quickly.');
    const result = checkOnlyRegressionProofChanged(BASE_FLOW, candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('changed-outside-regression-proof');
      expect(result.differences.some((d) => d.includes('implement'))).toBe(true);
    }
  });

  test('rejects a file that changes a merge option', () => {
    const candidate = BASE_FLOW.replace(
      'delete_branch: true',
      'delete_branch: true\n      require_regression_proof: false',
    );
    const result = checkOnlyRegressionProofChanged(BASE_FLOW, candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('changed-outside-regression-proof');
      expect(result.differences.some((d) => d.includes('merge'))).toBe(true);
    }
  });

  test('rejects a candidate that does not parse', () => {
    const result = checkOnlyRegressionProofChanged(BASE_FLOW, 'version: [invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('candidate-invalid');
    }
  });
});

describe('pruneRegressionProofRules', () => {
  test('removes rejected rules while preserving comments and other steps', () => {
    const input = `# header comment
name: issue-to-merge
nodes:
  - id: implement
    spawn_agent:
      prompt: "Implement the fix."
  - id: proof
    depends_on: [implement]
    regression_proof:
      setup_command: "pnpm install"
      rules:
        - globs: ["packages/a/**/*.test.ts"]
          command: "pnpm test {{files}}"
        - globs: ["packages/b/**/*.test.ts"]
          command: "broken {{files}}"
        - globs: ["packages/c/**/*.test.ts"]
          command: "pnpm test:c {{files}}"
  - id: merge
    depends_on: [proof]
    merge:
      method: squash
`;
    const pruned = pruneRegressionProofRules(input, new Set([0, 2]));
    expect(pruned).toContain('# header comment');
    expect(pruned).toContain('packages/a/**/*.test.ts');
    expect(pruned).not.toContain('packages/b/**/*.test.ts');
    expect(pruned).toContain('packages/c/**/*.test.ts');
    const parsed = parseWorkflowYaml(pruned, 'pruned');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const proofNode = parsed.workflow.nodes.find((n) => n.id === 'proof');
      expect(proofNode?.regression_proof?.rules).toHaveLength(2);
    }
  });
});

describe('buildOptOutWorkflowYaml', () => {
  test('sets require_regression_proof: false on the merge step and makes flow proof-ready', () => {
    const optOut = buildOptOutWorkflowYaml(BASE_FLOW);
    const parsed = parseWorkflowYaml(optOut, 'opt-out');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(isProofReady(parsed.workflow)).toBe(true);
      const mergeNode = parsed.workflow.nodes.find((n) => n.id === 'merge');
      expect(mergeNode?.merge?.require_regression_proof).toBe(false);
    }
  });
});
