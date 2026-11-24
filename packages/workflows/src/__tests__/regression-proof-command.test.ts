/**
 * A regression_proof rule's `{{files}}` is the proof's own placeholder: the
 * runner fills it with the changed test files. The flow's template rendering
 * must leave it alone, else the command runs the whole suite.
 */

import { describe, expect, test } from 'bun:test';

import { nullReporter, runPipeline } from '@funny/pipelines';

import type { ActionProvider, ActionResult } from '../compiler/action-provider.js';
import { compileYamlPipeline } from '../compiler/yaml-compiler.js';
import { parseWorkflowYaml } from '../parse.js';

const ok: ActionResult = { ok: true, output: '' };

const FLOW = `
name: proof-flow
inputs:
  repo: { type: string, required: true }
nodes:
  - id: proof
    regression_proof:
      rules:
        - globs: ['packages/client/**/*.test.ts']
          cwd: packages/client
          command: 'bun test --parallel {{files}}'
      setup_command: 'echo {{repo}}'
  - id: merge
    depends_on: [proof]
    merge: { method: squash }
`.trim();

describe('regression_proof rule commands', () => {
  test('keep their {{files}} placeholder; other fields are still interpolated', async () => {
    const parsed = parseWorkflowYaml(FLOW);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const proofs: Array<{ rules: Array<{ command: string }>; setupCommand?: string }> = [];
    const merges: Array<{ regressionProof?: { rules: Array<{ command: string }> } }> = [];
    const provider: ActionProvider = {
      spawnAgent: async () => ok,
      runCommand: async () => ok,
      gitCommit: async () => ok,
      gitPush: async () => ok,
      createPr: async () => ok,
      notify: async () => ok,
      setStatus: async () => ok,
      setStage: async () => ok,
      waitCi: async () => ok,
      requestApproval: async () => ({ decision: 'approve' }),
      regressionProof: async (opts) => {
        proofs.push(opts);
        return ok;
      },
      merge: async (opts) => {
        merges.push(opts);
        return ok;
      },
    };

    const result = await runPipeline(compileYamlPipeline(parsed.workflow), {
      provider,
      progress: nullReporter,
      cwd: '',
      inputs: { repo: 'o/r' },
      outputs: {},
    });

    expect(result.outcome).toBe('completed');
    expect(proofs[0]!.rules[0]!.command).toBe('bun test --parallel {{files}}');
    expect(proofs[0]!.setupCommand).toBe('echo o/r');
    expect(merges[0]!.regressionProof!.rules[0]!.command).toBe('bun test --parallel {{files}}');
  });
});
