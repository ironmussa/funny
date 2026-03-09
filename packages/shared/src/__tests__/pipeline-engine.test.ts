/**
 * Pipeline engine unit tests.
 *
 * Tests the core pipeline engine: node execution, guards, loops,
 * cancellation, state changes, compose, and subPipeline.
 */
import { describe, test, expect, vi } from 'vitest';

import { definePipeline, node, runPipeline, compose, subPipeline } from '../pipeline-engine.js';

describe('Pipeline Engine', () => {
  test('sequential pipeline runs nodes in order', async () => {
    const pipeline = definePipeline<{ value: number }>({
      name: 'test',
      nodes: [
        node('double', async (ctx) => ({ ...ctx, value: ctx.value * 2 })),
        node('add-one', async (ctx) => ({ ...ctx, value: ctx.value + 1 })),
      ],
    });

    const result = await runPipeline(pipeline, { value: 5 });
    expect(result.ctx.value).toBe(11);
    expect(result.outcome).toBe('completed');
  });

  test('node with when=false is skipped', async () => {
    const fn = vi.fn(async (ctx: { value: number }) => ({
      ...ctx,
      value: ctx.value + 100,
    }));

    const pipeline = definePipeline<{ value: number }>({
      name: 'test-skip',
      nodes: [
        node('always', async (ctx) => ({ ...ctx, value: ctx.value + 1 })),
        node('never', fn, { when: () => false }),
      ],
    });

    const result = await runPipeline(pipeline, { value: 0 });
    expect(result.ctx.value).toBe(1);
    expect(fn).not.toHaveBeenCalled();
  });

  test('loop repeats until condition met', async () => {
    const pipeline = definePipeline<{ count: number }>({
      name: 'test-loop',
      nodes: [node('increment', async (ctx) => ({ ...ctx, count: ctx.count + 1 }))],
      loop: {
        from: 'increment',
        until: (ctx) => ctx.count >= 3,
      },
    });

    const result = await runPipeline(pipeline, { count: 0 });
    expect(result.ctx.count).toBe(3);
  });

  test('respects maxIterations', async () => {
    const pipeline = definePipeline<{ count: number }>({
      name: 'test-max-iter',
      nodes: [node('increment', async (ctx) => ({ ...ctx, count: ctx.count + 1 }))],
      loop: {
        from: 'increment',
        until: () => false,
      },
    });

    const result = await runPipeline(pipeline, { count: 0 }, { maxIterations: 5 });
    expect(result.ctx.count).toBe(5);
    expect(result.outcome).toBe('failed');
  });

  test('cancellation via AbortSignal', async () => {
    const controller = new AbortController();

    const pipeline = definePipeline<{ count: number }>({
      name: 'test-cancel',
      nodes: [
        node('slow', async (ctx) => {
          if (ctx.count >= 1) controller.abort();
          return { ...ctx, count: ctx.count + 1 };
        }),
      ],
      loop: {
        from: 'slow',
        until: () => false,
      },
    });

    const result = await runPipeline(
      pipeline,
      { count: 0 },
      { signal: controller.signal, maxIterations: 100 },
    );
    expect(result.outcome).toBe('cancelled');
    expect(result.ctx.count).toBeLessThanOrEqual(2);
  });

  test('onStateChange reports entering, completed, and terminal', async () => {
    const changes: any[] = [];

    const pipeline = definePipeline<{ value: number }>({
      name: 'test-state-change',
      nodes: [
        node('step-a', async (ctx) => ({ ...ctx, value: ctx.value + 1 })),
        node('step-b', async (ctx) => ({ ...ctx, value: ctx.value + 2 })),
      ],
    });

    await runPipeline(
      pipeline,
      { value: 0 },
      {
        onStateChange: (change) => changes.push(change),
      },
    );

    const entering = changes.filter((c) => c.kind === 'entering');
    const completed = changes.filter((c) => c.kind === 'completed');
    const terminal = changes.filter((c) => c.kind === 'terminal');

    expect(entering.length).toBe(2);
    expect(completed.length).toBe(2);
    expect(terminal.length).toBe(1);
    expect(terminal[0].outcome).toBe('completed');
  });

  test('onStateChange reports error on node failure', async () => {
    const changes: any[] = [];

    const pipeline = definePipeline<{ value: number }>({
      name: 'test-error',
      nodes: [
        node('will-fail', async () => {
          throw new Error('boom');
        }),
      ],
    });

    await runPipeline(
      pipeline,
      { value: 0 },
      {
        onStateChange: (change) => changes.push(change),
      },
    );

    const terminal = changes.find((c: any) => c.kind === 'terminal');
    expect(terminal).toBeTruthy();
    expect(terminal.outcome).toBe('failed');
    expect(terminal.error).toContain('boom');
  });

  test('compose merges node arrays into flat list', () => {
    const group1 = [node<{ v: number }>('a', async (ctx) => ctx)];
    const group2 = [
      node<{ v: number }>('b', async (ctx) => ctx),
      node<{ v: number }>('c', async (ctx) => ctx),
    ];

    const result = compose(group1, group2);
    expect(result).toHaveLength(3);
    expect(result.map((n) => n.name)).toEqual(['a', 'b', 'c']);
  });

  test('subPipeline embeds a pipeline as a single node', async () => {
    const inner = definePipeline<{ value: number }>({
      name: 'inner',
      nodes: [node('add-ten', async (ctx) => ({ ...ctx, value: ctx.value + 10 }))],
    });

    const outer = definePipeline<{ value: number }>({
      name: 'outer',
      nodes: [
        node('add-one', async (ctx) => ({ ...ctx, value: ctx.value + 1 })),
        subPipeline('sub', inner),
      ],
    });

    const result = await runPipeline(outer, { value: 0 });
    expect(result.ctx.value).toBe(11);
    expect(result.outcome).toBe('completed');
  });

  test('subPipeline with guard skips when condition is false', async () => {
    const inner = definePipeline<{ value: number }>({
      name: 'inner',
      nodes: [node('add-100', async (ctx) => ({ ...ctx, value: ctx.value + 100 }))],
    });

    const outer = definePipeline<{ value: number }>({
      name: 'outer',
      nodes: [
        node('add-one', async (ctx) => ({ ...ctx, value: ctx.value + 1 })),
        subPipeline('sub', inner, { when: () => false }),
      ],
    });

    const result = await runPipeline(outer, { value: 0 });
    expect(result.ctx.value).toBe(1);
  });

  test('subPipeline with loop runs inner loop', async () => {
    const inner = definePipeline<{ value: number }>({
      name: 'inner-loop',
      nodes: [node('add-one', async (ctx) => ({ ...ctx, value: ctx.value + 1 }))],
      loop: {
        from: 'add-one',
        until: (ctx) => ctx.value >= 5,
      },
    });

    const outer = definePipeline<{ value: number }>({
      name: 'outer',
      nodes: [subPipeline('sub', inner)],
    });

    const result = await runPipeline(outer, { value: 0 });
    expect(result.ctx.value).toBe(5);
    expect(result.outcome).toBe('completed');
  });

  test('definePipeline throws if loop.from references non-existent node', () => {
    expect(() =>
      definePipeline<{ v: number }>({
        name: 'bad-loop',
        nodes: [node('a', async (ctx) => ctx)],
        loop: { from: 'nonexistent', until: () => true },
      }),
    ).toThrow('does not match any node name');
  });
});
