/**
 * Loop regions declared on nodes: repeat, nesting, overlap refusal, exhaustion.
 */
import { describe, expect, test } from 'bun:test';

import {
  definePipeline,
  node,
  runPipeline,
  type GuardFn,
  type NodeLoop,
  type PipelineNode,
} from '../engine.js';

type Ctx = { outputs: Record<string, number> };
const init = (): Ctx => ({ outputs: {} });

/** A node that counts its runs in `outputs[name]` and logs `name@iteration`. */
function counting(
  log: string[],
  name: string,
  deps: string[],
  opts: Partial<PipelineNode<Ctx>> = {},
): PipelineNode<Ctx> {
  return node<Ctx>(
    name,
    (ctx, _signal, info) => {
      log.push(`${name}@${info.iteration}`);
      return { ...ctx, outputs: { ...ctx.outputs, [name]: (ctx.outputs[name] ?? 0) + 1 } };
    },
    { dependsOn: deps, ...opts },
  );
}

const loop = (backTo: string, until: GuardFn<Ctx>, maxIterations?: number): NodeLoop<Ctx> => ({
  backTo,
  until,
  maxIterations,
});

describe('node loops', () => {
  test('review findings send the run back to the implementer; nodes after review wait', async () => {
    const log: string[] = [];
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'review-loop',
        nodes: [
          counting(log, 'triage', []),
          counting(log, 'implement', ['triage']),
          counting(log, 'ci', ['implement']),
          counting(log, 'review', ['ci'], {
            loop: loop('implement', (ctx) => ctx.outputs.review === 2, 3),
          }),
          counting(log, 'merge', ['review']),
        ],
      }),
      init(),
    );
    expect(result.outcome).toBe('completed');
    expect(log).toEqual([
      'triage@1',
      'implement@1',
      'ci@1',
      'review@1',
      'implement@2',
      'ci@2',
      'review@2',
      'merge@1',
    ]);
    // implement read review's result on its second visit, so counts carried over.
    expect(result.ctx.outputs).toEqual({ triage: 1, implement: 2, ci: 2, review: 2, merge: 1 });
  });

  test('until is checked after the declaring node, not after the last node', async () => {
    const log: string[] = [];
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'mid-loop',
        nodes: [
          counting(log, 'a', []),
          counting(log, 'b', ['a'], { loop: loop('a', (ctx) => ctx.outputs.b === 2) }),
          counting(log, 'c', ['b']),
        ],
      }),
      init(),
    );
    expect(log).toEqual(['a@1', 'b@1', 'a@2', 'b@2', 'c@1']);
    expect(result.iterations).toBe(2);
  });

  test('a branch outside the loop keeps running while the loop repeats', async () => {
    const log: string[] = [];
    await runPipeline(
      definePipeline<Ctx>({
        name: 'side-branch',
        nodes: [
          counting(log, 'start', []),
          counting(log, 'work', ['start'], { loop: loop('work', (ctx) => ctx.outputs.work === 3) }),
          counting(log, 'docs', ['start']),
        ],
      }),
      init(),
    );
    expect(log.filter((l) => l.startsWith('docs'))).toEqual(['docs@1']);
    expect(log.filter((l) => l.startsWith('work'))).toEqual(['work@1', 'work@2', 'work@3']);
  });

  test('nested loops: a conflict at merge repeats implement through merge, including ci’s loop', async () => {
    const log: string[] = [];
    let ciRuns = 0;
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'nested',
        nodes: [
          counting(log, 'implement', []),
          node<Ctx>(
            'ci',
            (ctx, _s, info) => {
              ciRuns++;
              log.push(`ci@${info.iteration}`);
              return { ...ctx, outputs: { ...ctx.outputs, ci: info.iteration } };
            },
            {
              dependsOn: ['implement'],
              // CI goes green on its second look, every time.
              loop: loop('implement', (ctx) => ctx.outputs.ci === 2, 3),
            },
          ),
          counting(log, 'merge', ['ci'], {
            // The first merge conflicts.
            loop: loop('implement', (ctx) => ctx.outputs.merge === 2, 3),
          }),
        ],
      }),
      init(),
    );
    expect(result.outcome).toBe('completed');
    expect(ciRuns).toBe(4);
    expect(log).toEqual([
      'implement@1',
      'ci@1',
      'implement@2',
      'ci@2',
      'merge@1',
      // merge's loop: ci's loop starts over at visit 1.
      'implement@1',
      'ci@1',
      'implement@2',
      'ci@2',
      'merge@2',
    ]);
  });

  test('overlapping loops are refused before any node runs, naming both loops', async () => {
    const log: string[] = [];
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'overlap',
        nodes: [
          counting(log, 'a', []),
          counting(log, 'b', ['a']),
          counting(log, 'c', ['b'], { loop: loop('a', () => true) }),
          counting(log, 'd', ['c'], { loop: loop('b', () => true) }),
        ],
      }),
      init(),
    );
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/"c".*"d".*overlap/);
    expect(log).toEqual([]);
  });

  test('a loop back to a node that is not a dependency is refused', async () => {
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'bad-back-to',
        nodes: [counting([], 'a', []), counting([], 'b', [], { loop: loop('a', () => true) })],
      }),
      init(),
    );
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/has no region/);
  });

  test('loop exhausted fails the declaring node and fails the run by default', async () => {
    const log: string[] = [];
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'exhausted',
        nodes: [
          counting(log, 'fix', []),
          counting(log, 'check', ['fix'], { loop: loop('fix', () => false, 3) }),
          counting(log, 'after', ['check']),
        ],
      }),
      init(),
    );
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/loop exhausted/);
    expect(log.filter((l) => l.startsWith('check'))).toHaveLength(3);
    expect(log).not.toContain('after@1');
  });

  test('loop exhausted with onError continue lets the joins decide', async () => {
    const log: string[] = [];
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'exhausted-continue',
        nodes: [
          counting(log, 'fix', []),
          counting(log, 'check', ['fix'], {
            loop: loop('fix', () => false, 2),
            onError: 'continue',
          }),
          counting(log, 'needs-pass', ['check']),
          counting(log, 'report', ['check'], { triggerRule: 'all_done' }),
        ],
      }),
      init(),
    );
    expect(result.outcome).toBe('completed');
    expect(log).not.toContain('needs-pass@1');
    expect(log).toContain('report@1');
  });

  test('a code-review shaped loop behaves as before: a pass skips the fix and ends the loop', async () => {
    const verdicts = ['fail', 'pass'];
    const log: string[] = [];
    const isFail: GuardFn<Ctx> = (ctx) => verdicts[ctx.outputs.review - 1] === 'fail';
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'code-review',
        nodes: [
          counting(log, 'review', []),
          counting(log, 'fix', ['review'], { when: isFail }),
          counting(log, 'commit-fix', ['fix'], {
            when: isFail,
            loop: loop('review', (ctx) => verdicts[ctx.outputs.review - 1] === 'pass', 10),
          }),
        ],
      }),
      init(),
    );
    expect(result.outcome).toBe('completed');
    expect(log).toEqual(['review@1', 'fix@1', 'commit-fix@1', 'review@2']);
  });
});
