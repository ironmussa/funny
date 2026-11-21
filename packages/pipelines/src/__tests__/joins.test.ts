/**
 * Join rules (`triggerRule`) and skip propagation.
 */
import { describe, expect, test, vi } from 'bun:test';

import { definePipeline, node, runPipeline, type PipelineNode } from '../engine.js';

type Ctx = { outputs: Record<string, unknown> };
const init = (): Ctx => ({ outputs: {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ok = (name: string, deps: string[], opts: Partial<PipelineNode<Ctx>> = {}, delayMs = 0) =>
  node<Ctx>(
    name,
    async (ctx) => {
      if (delayMs > 0) await sleep(delayMs);
      return { ...ctx, outputs: { ...ctx.outputs, [name]: true } };
    },
    { dependsOn: deps, ...opts },
  );

const boom = (name: string, deps: string[]) =>
  node<Ctx>(
    name,
    async () => {
      throw new Error(`${name} failed`);
    },
    { dependsOn: deps, onError: 'continue' },
  );

function run(nodes: PipelineNode<Ctx>[]) {
  const kinds: Record<string, string[]> = {};
  const result = runPipeline(definePipeline<Ctx>({ name: 'joins', nodes }), init(), {
    onStateChange: (c) => {
      if (c.kind !== 'terminal') (kinds[c.nodeName] ??= []).push(c.kind);
    },
  });
  return { result, kinds };
}

describe('trigger rules', () => {
  test('default join with a failed branch is skipped', async () => {
    const join = vi.fn((ctx: Ctx) => ctx);
    const { result, kinds } = run([
      ok('a', []),
      boom('b', []),
      node('join', join, { dependsOn: ['a', 'b'] }),
    ]);
    const r = await result;
    expect(r.outcome).toBe('completed');
    expect(join).not.toHaveBeenCalled();
    expect(kinds.join).toEqual(['skipped']);
  });

  test('a default join skips as soon as one dependency fails, without waiting for the rest', async () => {
    const order: string[] = [];
    const { result, kinds } = run([
      node<Ctx>(
        'slow',
        async (ctx) => {
          await sleep(40);
          order.push('slow-end');
          return ctx;
        },
        { dependsOn: [] },
      ),
      boom('fast-fail', []),
      ok('join', ['slow', 'fast-fail']),
      node<Ctx>(
        'probe',
        (ctx) => {
          order.push('probe');
          return ctx;
        },
        { dependsOn: ['join'], triggerRule: 'all_done' },
      ),
    ]);
    await result;
    expect(kinds.join).toEqual(['skipped']);
    // probe follows the skipped join, before the slow sibling ends.
    expect(order).toEqual(['probe', 'slow-end']);
  });

  test('skip propagates down a chain of default joins', async () => {
    const { result, kinds } = run([boom('a', []), ok('b', ['a']), ok('c', ['b'])]);
    const r = await result;
    expect(r.outcome).toBe('completed');
    expect(kinds.b).toEqual(['skipped']);
    expect(kinds.c).toEqual(['skipped']);
  });

  test('a dependency skipped by its guard counts as done', async () => {
    const { result } = run([ok('a', [], { when: () => false }), ok('b', ['a'])]);
    const r = await result;
    expect(r.ctx.outputs).toEqual({ b: true });
  });

  test('all_done runs after a failed dependency', async () => {
    const { result } = run([
      ok('a', []),
      boom('b', []),
      ok('cleanup', ['a', 'b'], { triggerRule: 'all_done' }),
    ]);
    const r = await result;
    expect(r.ctx.outputs).toMatchObject({ a: true, cleanup: true });
  });

  test('all_done waits for every dependency', async () => {
    const order: string[] = [];
    const { result } = run([
      node<Ctx>(
        'slow',
        async (ctx) => {
          await sleep(30);
          order.push('slow');
          return ctx;
        },
        { dependsOn: [] },
      ),
      ok('fast', []),
      node<Ctx>(
        'after',
        (ctx) => {
          order.push('after');
          return ctx;
        },
        { dependsOn: ['slow', 'fast'], triggerRule: 'all_done' },
      ),
    ]);
    await result;
    expect(order).toEqual(['slow', 'after']);
  });

  test('one_success starts on the first success without waiting for or cancelling the second', async () => {
    const order: string[] = [];
    let slowAborted = false;
    const { result } = run([
      ok('first', []),
      node<Ctx>(
        'second',
        async (ctx, signal) => {
          signal.addEventListener('abort', () => (slowAborted = true));
          await sleep(40);
          order.push('second');
          return { ...ctx, outputs: { ...ctx.outputs, second: true } };
        },
        { dependsOn: [] },
      ),
      node<Ctx>(
        'any',
        (ctx) => {
          order.push(`any:${Object.keys(ctx.outputs).join(',')}`);
          return ctx;
        },
        { dependsOn: ['first', 'second'], triggerRule: 'one_success' },
      ),
    ]);
    const r = await result;
    expect(order).toEqual(['any:first', 'second']);
    expect(slowAborted).toBe(false);
    expect(r.ctx.outputs).toMatchObject({ first: true, second: true });
  });

  test('one_success is skipped when every dependency fails', async () => {
    const { result, kinds } = run([
      boom('a', []),
      boom('b', []),
      ok('any', ['a', 'b'], { triggerRule: 'one_success' }),
    ]);
    await result;
    expect(kinds.any).toEqual(['skipped']);
  });

  test('a failure with the default onError still fails the run', async () => {
    const r = await runPipeline(
      definePipeline<Ctx>({
        name: 'fail',
        nodes: [
          node<Ctx>(
            'a',
            async () => {
              throw new Error('a failed');
            },
            { dependsOn: [] },
          ),
          ok('b', ['a'], { triggerRule: 'all_done' }),
        ],
      }),
      init(),
    );
    expect(r.outcome).toBe('failed');
    expect(r.error).toBe('a failed');
    expect(r.ctx.outputs).toEqual({});
  });
});
