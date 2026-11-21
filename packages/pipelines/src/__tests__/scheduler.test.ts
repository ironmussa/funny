/**
 * Ready-queue scheduler: behaviour the level-by-level mode could not give.
 */
import { describe, expect, test, vi } from 'bun:test';

import { definePipeline, node, runPipeline } from '../engine.js';

type Ctx = { outputs: Record<string, unknown> };
const init = (): Ctx => ({ outputs: {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A node that records when it starts and writes its name to `outputs`. */
function recording(log: string[], name: string, deps: string[], delayMs = 0) {
  return node<Ctx>(
    name,
    async (ctx) => {
      log.push(`start:${name}`);
      if (delayMs > 0) await sleep(delayMs);
      log.push(`end:${name}`);
      return { ...ctx, outputs: { ...ctx.outputs, [name]: Object.keys(ctx.outputs).sort() } };
    },
    { dependsOn: deps },
  );
}

describe('ready-queue scheduler', () => {
  test('a slow branch does not hold another branch', async () => {
    const log: string[] = [];
    // slow ─┐
    // fast ─┴ (independent) ; after-fast depends only on fast.
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'branches',
        nodes: [
          recording(log, 'slow', [], 60),
          recording(log, 'fast', []),
          recording(log, 'after-fast', ['fast']),
        ],
      }),
      init(),
    );
    expect(result.outcome).toBe('completed');
    // Under levels, after-fast would start only once slow had ended.
    expect(log.indexOf('start:after-fast')).toBeLessThan(log.indexOf('end:slow'));
  });

  test('a node reads only what its dependencies produced', async () => {
    const log: string[] = [];
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'reads',
        nodes: [recording(log, 'a', []), recording(log, 'b', [], 20), recording(log, 'c', ['a'])],
      }),
      init(),
    );
    // c starts before b ends, and never sees b's output even when b finishes first elsewhere.
    expect(result.ctx.outputs.c).toEqual(['a']);
    expect(result.ctx.outputs).toMatchObject({ a: [], b: [], c: ['a'] });
  });

  test('a join reads every dependency, merged in declaration order', async () => {
    const log: string[] = [];
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'join',
        nodes: [
          recording(log, 'left', [], 15),
          recording(log, 'right', []),
          recording(log, 'join', ['left', 'right']),
        ],
      }),
      init(),
    );
    expect(result.ctx.outputs.join).toEqual(['left', 'right']);
  });

  test('a flow without dependsOn runs in declaration order, each node reading the previous one', async () => {
    const seen: number[] = [];
    const step = (name: string) =>
      node<number>(name, async (n) => {
        seen.push(n);
        await sleep(1);
        return n + 1;
      });
    const result = await runPipeline(
      definePipeline<number>({ name: 'chain', nodes: [step('a'), step('b'), step('c')] }),
      0,
    );
    expect(seen).toEqual([0, 1, 2]);
    expect(result.ctx).toBe(3);
  });

  test('declaration order need not be topological', async () => {
    const log: string[] = [];
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'unordered',
        nodes: [recording(log, 'second', ['first']), recording(log, 'first', [])],
      }),
      init(),
    );
    expect(result.outcome).toBe('completed');
    expect(log).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  test('a node outside a loop waits until the loop exits', async () => {
    const log: string[] = [];
    let reviews = 0;
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'loop-outside',
        nodes: [
          recording(log, 'start', []),
          node<Ctx>(
            'review',
            async (ctx) => {
              reviews++;
              log.push(`review:${reviews}`);
              return { ...ctx, outputs: { ...ctx.outputs, reviews } };
            },
            { dependsOn: ['start'] },
          ),
          recording(log, 'report', ['review']),
          recording(log, 'fix', ['review']),
        ],
        loop: { from: 'review', until: (ctx) => ctx.outputs.reviews === 3 },
      }),
      init(),
    );
    expect(result.outcome).toBe('completed');
    expect(result.iterations).toBe(3);
    // report is outside the region (review → fix), so it runs once, after the last review.
    expect(log.filter((l) => l === 'start:report')).toHaveLength(1);
    expect(log.indexOf('start:report')).toBeGreaterThan(log.indexOf('review:3'));
  });

  test('a loop whose start is not on a path to the last node fails the run', async () => {
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'no-region',
        nodes: [recording([], 'a', []), recording([], 'b', [])],
        loop: { from: 'a', until: () => true },
      }),
      init(),
    );
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/has no region/);
  });

  test('a synchronous node that aborts the run keeps its result, and the next node never starts', async () => {
    const controller = new AbortController();
    const next = vi.fn((n: number) => n + 100);
    const result = await runPipeline(
      definePipeline<number>({
        name: 'sync-abort',
        nodes: [
          node('commit', (n) => {
            controller.abort();
            return n + 1;
          }),
          node('next', next),
        ],
      }),
      0,
      { signal: controller.signal },
    );
    expect(result.outcome).toBe('cancelled');
    expect(result.ctx).toBe(1);
    expect(next).not.toHaveBeenCalled();
  });

  test('a loop that starts after the first node returns the last node result', async () => {
    const result = await runPipeline(
      definePipeline<number>({
        name: 'late-loop',
        nodes: [node('setup', (n) => n + 10), node('step', (n) => n + 1)],
        loop: { from: 'step', until: (n) => n >= 13 },
      }),
      0,
    );
    expect(result.outcome).toBe('completed');
    expect(result.ctx).toBe(13);
    expect(result.iterations).toBe(3);
  });
});
