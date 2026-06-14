/**
 * Pipeline engine unit tests.
 *
 * Tests the core pipeline engine: node execution, guards, loops,
 * cancellation, state changes, compose, and subPipeline.
 */
import { describe, test, expect, vi } from 'vitest';

import {
  definePipeline,
  node,
  runPipeline,
  compose,
  subPipeline,
  computeLevels,
} from '../engine.js';

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
        node('will-fail', async (_ctx) => {
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

  describe('node retry', () => {
    test('retries up to maxAttempts when node throws', async () => {
      let attempts = 0;
      const pipeline = definePipeline<{ ok: boolean }>({
        name: 'test-retry',
        nodes: [
          node(
            'flaky',
            async (ctx) => {
              attempts++;
              if (attempts < 3) throw new Error('transient');
              return { ...ctx, ok: true };
            },
            { retry: { maxAttempts: 3 } },
          ),
        ],
      });

      const result = await runPipeline(pipeline, { ok: false });
      expect(result.outcome).toBe('completed');
      expect(attempts).toBe(3);
      expect(result.ctx.ok).toBe(true);
    });

    test('fails after exhausting maxAttempts', async () => {
      let attempts = 0;
      const pipeline = definePipeline<{ tag: string }>({
        name: 'test-retry-exhaust',
        nodes: [
          node<{ tag: string }>(
            'always-fails',
            async () => {
              attempts++;
              throw new Error('boom');
            },
            { retry: { maxAttempts: 2 } },
          ),
        ],
      });

      const result = await runPipeline(pipeline, { tag: 'x' });
      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('boom');
      expect(attempts).toBe(2);
    });

    test('beforeRetry can mutate context between attempts', async () => {
      const pipeline = definePipeline<{ token: string }>({
        name: 'test-before-retry',
        nodes: [
          node(
            'auth-call',
            async (ctx) => {
              if (ctx.token !== 'fresh') throw new Error('expired');
              return ctx;
            },
            {
              retry: {
                maxAttempts: 2,
                beforeRetry: async (_err, ctx) => ({ ...ctx, token: 'fresh' }),
              },
            },
          ),
        ],
      });

      const result = await runPipeline(pipeline, { token: 'stale' });
      expect(result.outcome).toBe('completed');
      expect(result.ctx.token).toBe('fresh');
    });

    test('shouldRetry=false aborts retries early', async () => {
      let attempts = 0;
      const pipeline = definePipeline<{ tag: string }>({
        name: 'test-should-retry',
        nodes: [
          node<{ tag: string }>(
            'permanent-fail',
            async () => {
              attempts++;
              throw new Error('not-retryable');
            },
            {
              retry: {
                maxAttempts: 5,
                shouldRetry: (err) => !err.message.includes('not-retryable'),
              },
            },
          ),
        ],
      });

      const result = await runPipeline(pipeline, { tag: 'x' });
      expect(result.outcome).toBe('failed');
      expect(attempts).toBe(1);
    });

    test('cancellation during retry sleep short-circuits the loop', async () => {
      const controller = new AbortController();
      const pipeline = definePipeline<{ tag: string }>({
        name: 'test-retry-cancel',
        nodes: [
          node<{ tag: string }>(
            'flaky',
            async () => {
              controller.abort();
              throw new Error('boom');
            },
            { retry: { maxAttempts: 5, delayMs: 10 } },
          ),
        ],
      });

      const result = await runPipeline(pipeline, { tag: 'x' }, { signal: controller.signal });
      expect(result.outcome).toBe('failed');
    });

    test('maxAttempts can be a function of context', async () => {
      let attempts = 0;
      const pipeline = definePipeline<{ limit: number }>({
        name: 'test-fn-max',
        nodes: [
          node(
            'fail-twice',
            async (ctx) => {
              attempts++;
              if (attempts < 3) throw new Error('x');
              return ctx;
            },
            { retry: { maxAttempts: (ctx) => ctx.limit } },
          ),
        ],
      });

      const result = await runPipeline(pipeline, { limit: 3 });
      expect(result.outcome).toBe('completed');
      expect(attempts).toBe(3);
    });
  });

  // ── Phase 3: DAG parallel execution ───────────────────────
  describe('DAG mode (dependsOn)', () => {
    type Ctx = { outputs: Record<string, unknown> };
    const init = (): Ctx => ({ outputs: {} });

    /** Node that records its own name into outputs and (optionally) tracks concurrency. */
    const trackNode = (
      name: string,
      deps: string[],
      track?: { active: { n: number }; max: { n: number }; delayMs?: number },
    ) =>
      node<Ctx>(
        name,
        async (ctx) => {
          if (track) {
            track.active.n++;
            track.max.n = Math.max(track.max.n, track.active.n);
            await new Promise((r) => setTimeout(r, track.delayMs ?? 10));
            track.active.n--;
          }
          return { ...ctx, outputs: { ...ctx.outputs, [name]: name } };
        },
        { dependsOn: deps },
      );

    test('computeLevels groups a diamond into topological levels', () => {
      const levels = computeLevels<Ctx>([
        trackNode('a', []),
        trackNode('b', ['a']),
        trackNode('c', ['a']),
        trackNode('d', ['b', 'c']),
      ]);
      expect(levels.map((l) => l.map((n) => n.name))).toEqual([['a'], ['b', 'c'], ['d']]);
    });

    test('computeLevels throws on a cycle', () => {
      expect(() => computeLevels<Ctx>([trackNode('a', ['b']), trackNode('b', ['a'])])).toThrow(
        /Cycle detected/,
      );
    });

    test('computeLevels throws on an unknown dependency', () => {
      expect(() => computeLevels<Ctx>([trackNode('a', ['ghost'])])).toThrow(/does not exist/);
    });

    test('independent nodes run concurrently (wall-clock ≈ max, not sum)', async () => {
      const active = { n: 0 };
      const max = { n: 0 };
      const pipeline = definePipeline<Ctx>({
        name: 'fan-out',
        nodes: [
          trackNode('a', [], { active, max }),
          trackNode('b', [], { active, max }),
          trackNode('c', [], { active, max }),
        ],
      });

      const result = await runPipeline(pipeline, init());
      expect(result.outcome).toBe('completed');
      expect(max.n).toBe(3); // all three were in flight at once
      expect(result.ctx.outputs).toEqual({ a: 'a', b: 'b', c: 'c' });
    });

    test('dependents wait for their dependencies', async () => {
      const order: string[] = [];
      const rec = (name: string, deps: string[]) =>
        node<Ctx>(
          name,
          async (ctx) => {
            order.push(name);
            return ctx;
          },
          { dependsOn: deps },
        );

      // diamond: a → {b, c} → d
      const result = await runPipeline(
        definePipeline<Ctx>({
          name: 'diamond',
          nodes: [rec('a', []), rec('b', ['a']), rec('c', ['a']), rec('d', ['b', 'c'])],
        }),
        init(),
      );

      expect(result.outcome).toBe('completed');
      expect(order[0]).toBe('a');
      expect(order[3]).toBe('d');
      expect(order.slice(1, 3).sort()).toEqual(['b', 'c']);
    });

    test('merge is deterministic regardless of which sibling finishes first', async () => {
      // `b` finishes long before `a`, but the fold uses declaration order.
      const slow = node<Ctx>(
        'a',
        async (ctx) => {
          await new Promise((r) => setTimeout(r, 25));
          return { ...ctx, outputs: { ...ctx.outputs, last: 'a' } };
        },
        { dependsOn: [] },
      );
      const fast = node<Ctx>(
        'b',
        async (ctx) => {
          await new Promise((r) => setTimeout(r, 1));
          return { ...ctx, outputs: { ...ctx.outputs, last: 'b' } };
        },
        { dependsOn: [] },
      );

      const result = await runPipeline(
        definePipeline<Ctx>({ name: 'det', nodes: [slow, fast] }),
        init(),
      );
      // Declaration order [a, b] ⇒ b's value wins on the shared key.
      expect((result.ctx.outputs as Record<string, unknown>).last).toBe('b');
    });

    test('a node failure fails the pipeline after its level settles', async () => {
      const result = await runPipeline(
        definePipeline<Ctx>({
          name: 'boom',
          nodes: [
            trackNode('a', []),
            node<Ctx>(
              'b',
              async () => {
                throw new Error('b exploded');
              },
              { dependsOn: [] },
            ),
          ],
        }),
        init(),
      );
      expect(result.outcome).toBe('failed');
      expect(result.error).toMatch(/b exploded/);
    });

    test('maxConcurrency caps in-flight nodes within a level', async () => {
      const active = { n: 0 };
      const max = { n: 0 };
      const pipeline = definePipeline<Ctx>({
        name: 'capped',
        nodes: [
          trackNode('a', [], { active, max }),
          trackNode('b', [], { active, max }),
          trackNode('c', [], { active, max }),
          trackNode('d', [], { active, max }),
        ],
      });

      const result = await runPipeline(pipeline, init(), { maxConcurrency: 2 });
      expect(result.outcome).toBe('completed');
      expect(max.n).toBe(2);
    });

    test('skipped sibling (when=false) contributes no output but does not fail', async () => {
      const result = await runPipeline(
        definePipeline<Ctx>({
          name: 'skip-sibling',
          nodes: [
            trackNode('a', []),
            node<Ctx>('b', async (ctx) => ({ ...ctx, outputs: { ...ctx.outputs, b: 'b' } }), {
              dependsOn: [],
              when: () => false,
            }),
          ],
        }),
        init(),
      );
      expect(result.outcome).toBe('completed');
      expect(result.ctx.outputs).toEqual({ a: 'a' });
    });

    test('backward-compat: no dependsOn anywhere stays sequential', async () => {
      const active = { n: 0 };
      const max = { n: 0 };
      // No dependsOn ⇒ legacy sequential path; nodes never overlap.
      const seqNode = (name: string) =>
        node<Ctx>(name, async (ctx) => {
          active.n++;
          max.n = Math.max(max.n, active.n);
          await new Promise((r) => setTimeout(r, 5));
          active.n--;
          return ctx;
        });

      await runPipeline(
        definePipeline<Ctx>({ name: 'legacy', nodes: [seqNode('a'), seqNode('b')] }),
        init(),
      );
      expect(max.n).toBe(1);
    });
  });
});
