import { describe, expect, test } from 'bun:test';

/**
 * The compiler maps the graph fields of the DAG engine: trigger_rule,
 * several loops, concurrency groups, LOOP_ITERATION and the execution
 * passed to actions.
 */
import {
  createMemoryConcurrencyGate,
  createMemoryJournal,
  nullReporter,
  runPipeline,
  type PipelineRunOptions,
} from '@funny/pipelines';
import type { JsonObject } from '@funny/shared/json';

import type { ActionProvider, ActionResult, SpawnAgentOpts } from '../compiler/action-provider.js';
import { compileYamlPipeline, type YamlPipelineContext } from '../compiler/yaml-compiler.js';
import { parseWorkflowYaml } from '../parse.js';

const ok: ActionResult = { ok: true, output: '' };

function provider(spawn: (opts: SpawnAgentOpts) => Promise<ActionResult> = async () => ok) {
  const spawns: SpawnAgentOpts[] = [];
  const notes: string[] = [];
  const p: ActionProvider = {
    spawnAgent: async (opts) => {
      spawns.push(opts);
      return spawn(opts);
    },
    runCommand: async () => ok,
    gitCommit: async () => ok,
    gitPush: async () => ok,
    createPr: async () => ok,
    notify: async ({ message }) => {
      notes.push(message);
      return ok;
    },
    setStatus: async () => ok,
    setStage: async () => ok,
    waitCi: async () => ok,
    merge: async () => ok,
    requestApproval: async () => ({ decision: 'approve' }),
  };
  return { p, spawns, notes };
}

function compile(yaml: string) {
  const parsed = parseWorkflowYaml(yaml);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return compileYamlPipeline(parsed.workflow);
}

function run(
  yaml: string,
  p: ActionProvider,
  inputs: JsonObject = {},
  opts: PipelineRunOptions<YamlPipelineContext> = {},
) {
  const ctx: YamlPipelineContext = {
    provider: p,
    progress: nullReporter,
    cwd: '/r',
    inputs,
    outputs: {},
  };
  return runPipeline(compile(yaml), ctx, opts);
}

describe('compiler: graph fields', () => {
  test('several loops compile and run, each checked after its own node', async () => {
    const { p, notes } = provider();
    const result = await run(
      `
name: loops
nodes:
  - id: implement
    notify: { message: 'implement {{LOOP_ITERATION}}' }
  - id: ci
    depends_on: [implement]
    notify: { message: 'ci {{LOOP_ITERATION}}' }
    loop: { back_to: implement, until: '$exists(ci) and true', max_iterations: 3 }
  - id: review
    depends_on: [ci]
    notify: { message: 'review {{LOOP_ITERATION}}' }
    loop: { back_to: review, until: 'true', max_iterations: 2 }
`,
      p,
    );
    expect(result.outcome).toBe('completed');
    expect(notes).toEqual(['implement 1', 'ci 1', 'review 1']);
  });

  test('LOOP_ITERATION follows the visits of the loop', async () => {
    let seen = 0;
    const { p, notes } = provider();
    const counting: ActionProvider = {
      ...p,
      notify: async (opts) => {
        seen++;
        return p.notify(opts);
      },
    };
    await run(
      `
name: visits
nodes:
  - id: fix
    notify: { message: 'visit {{LOOP_ITERATION}}' }
    loop: { until: 'false', max_iterations: 3 }
`,
      counting,
    );
    expect(seen).toBe(3);
    expect(notes).toEqual(['visit 1', 'visit 2', 'visit 3']);
  });

  test('trigger_rule one_success starts on the first success', async () => {
    const { p, notes } = provider(async (opts) =>
      opts.prompt === 'bad' ? { ok: false, error: 'no' } : ok,
    );
    await run(
      `
name: any
nodes:
  - id: a
    on_error: continue
    spawn_agent: { prompt: bad }
  - id: b
    spawn_agent: { prompt: good }
  - id: any
    depends_on: [a, b]
    trigger_rule: one_success
    notify: { message: ran }
`,
      p,
    );
    expect(notes).toEqual(['ran']);
  });

  test('a concurrency group is rendered from the inputs and limits runs', async () => {
    const gate = createMemoryConcurrencyGate();
    const order: string[] = [];
    const slow = (repo: string): ActionProvider => ({
      ...provider().p,
      merge: async () => {
        order.push(`start ${repo}`);
        await new Promise((r) => setTimeout(r, 15));
        order.push(`end ${repo}`);
        return ok;
      },
    });
    const flow = `
name: merge
nodes:
  - id: merge
    concurrency: { group: 'merge-{{repo}}', limit: 1 }
    merge: {}
`;
    await Promise.all([
      run(flow, slow('a1'), { repo: 'a' }, { gate }),
      run(flow, slow('a2'), { repo: 'a' }, { gate }),
      run(flow, slow('b1'), { repo: 'b' }, { gate }),
    ]);
    // a1 and a2 never overlap; b1 does not wait for them.
    expect(order.indexOf('start a2')).toBeGreaterThan(order.indexOf('end a1'));
    expect(order.indexOf('start b1')).toBeLessThan(order.indexOf('end a1'));
  });

  test('a resumed agent step gets what it checkpointed', async () => {
    const journal = createMemoryJournal<YamlPipelineContext>();
    const flow = `
name: resume
nodes:
  - id: implement
    spawn_agent: { prompt: go }
`;
    const controller = new AbortController();
    const first = provider(async (opts) => {
      await opts.execution?.checkpoint({ threadId: 't-1' });
      controller.abort();
      return new Promise<ActionResult>(() => {});
    });
    await run(
      flow,
      first.p,
      {},
      { journal, runId: 'r', signal: controller.signal, stopGraceMs: 10 },
    );

    const second = provider();
    const result = await run(flow, second.p, {}, { journal, runId: 'r' });
    expect(result.outcome).toBe('completed');
    expect(second.spawns[0].execution?.resume?.recorded.data).toEqual({ threadId: 't-1' });
  });
});
