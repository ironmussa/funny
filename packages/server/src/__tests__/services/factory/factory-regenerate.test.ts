/**
 * A regenerable change (openspec factory-integration 3.5, D9): a flow whose
 * `merge` names the node that produces the change re-runs that node when the
 * change conflicts with the base, instead of resolving the conflict; the flow
 * loader refuses a `regenerate` the merge loop does not go back to.
 */
import { describe, expect, test } from 'bun:test';

import { nullReporter, runPipeline } from '@funny/pipelines';
import { parseWorkflowYaml } from '@funny/workflows';
import {
  compileYamlPipeline,
  type ActionProvider,
  type ActionResult,
} from '@funny/workflows/compiler';

import { validateFactoryFlow } from '../../../services/factory/factory-flow-validation.js';

const FLOW = `name: codemod
nodes:
  - id: implement
    spawn_agent: { prompt: Rename the API. }
  - id: codemod
    depends_on: [implement]
    run_command: { command: 'bun run codemod' }
  - id: pull-request
    depends_on: [codemod]
    create_pr: { title: Rename the API }
  - id: merge
    depends_on: [pull-request]
    merge: { regenerate: codemod }
    loop:
      back_to: codemod
      until: '$not(merge.json.outcome = "sent_back")'
      max_iterations: 3
`;

function parsed(yaml: string) {
  const result = parseWorkflowYaml(yaml, 'codemod.yaml');
  if (!result.ok) throw new Error(result.error.message);
  return result.workflow;
}

const ok: ActionResult = { ok: true, output: '' };

describe('a regenerable change', () => {
  test('a conflict at merge time re-runs the codemod on the new base; no agent fixes it', async () => {
    const commands: string[] = [];
    const prompts: string[] = [];
    const merges: Array<string | undefined> = [];
    const results: ActionResult[] = [
      {
        ok: true,
        output: 'sent_back',
        metadata: {
          outcome: 'sent_back',
          why: 'conflict',
          feedback: 'conflict',
          regenerate: 'codemod',
        },
      },
      { ok: true, output: 'merged', metadata: { outcome: 'merged' } },
    ];
    const provider: ActionProvider = {
      spawnAgent: async (opts) => {
        prompts.push(opts.prompt);
        return ok;
      },
      runCommand: async (opts) => {
        commands.push(opts.command);
        return { ok: true, output: 'regenerated' };
      },
      gitCommit: async () => ok,
      gitPush: async () => ok,
      createPr: async () => ok,
      notify: async () => ok,
      setStatus: async () => ok,
      setStage: async () => ok,
      waitCi: async () => ok,
      merge: async (opts) => {
        merges.push(opts.regenerate);
        return results.shift()!;
      },
      requestApproval: async () => ({ decision: 'approve' }),
    };
    const result = await runPipeline(compileYamlPipeline(parsed(FLOW)), {
      provider,
      progress: nullReporter,
      cwd: '',
      inputs: {},
      outputs: {},
    });
    expect(result.outcome).toBe('completed');
    expect(commands).toEqual(['bun run codemod', 'bun run codemod']);
    expect(merges).toEqual(['codemod', 'codemod']);
    // The implementing agent ran once: the conflict did not go to it.
    expect(prompts).toHaveLength(1);
  });

  test('the flow loads', () => {
    expect(validateFactoryFlow(parsed(FLOW))).toEqual([]);
  });

  test('a regenerate that names no producing node, or that the loop does not go back to, is refused', () => {
    const missing = FLOW.replace(
      'merge: { regenerate: codemod }',
      'merge: { regenerate: nowhere }',
    );
    expect(validateFactoryFlow(parsed(missing))).toEqual([
      { step: 'merge', field: 'regenerate', message: expect.stringContaining('"nowhere"') },
    ]);
    const elsewhere = FLOW.replace('back_to: codemod', 'back_to: pull-request');
    expect(validateFactoryFlow(parsed(elsewhere))).toEqual([
      { step: 'merge', field: 'regenerate', message: expect.stringContaining('loop.back_to') },
    ]);
  });
});
