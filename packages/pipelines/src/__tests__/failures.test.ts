/**
 * Failure and cancellation across parallel branches.
 */
import { describe, expect, test, vi } from 'vitest';

import { definePipeline, node, runPipeline, type PipelineNode } from '../engine.js';

type Ctx = { outputs: Record<string, unknown> };
const init = (): Ctx => ({ outputs: {} });

/** A node that runs until its signal aborts, recording that it was aborted and that it settled. */
function blocking(name: string, deps: string[], probe: { aborted: string[]; settled: string[] }) {
  const started = Promise.withResolvers<void>();
  const def = node<Ctx>(
    name,
    (_ctx, signal) =>
      new Promise<Ctx>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            probe.aborted.push(name);
            // Settle a little later, so the run must really wait for it.
            setTimeout(() => {
              probe.settled.push(name);
              reject(new Error(`${name} stopped`));
            }, 10);
          },
          { once: true },
        );
        started.resolve();
      }),
    { dependsOn: deps },
  );
  return { def, started: started.promise };
}

const failing = (name: string, deps: string[], after: Promise<unknown>, opts = {}) =>
  node<Ctx>(
    name,
    async () => {
      await after;
      throw new Error(`${name} failed`);
    },
    { dependsOn: deps, ...opts },
  );

describe('failure across branches', () => {
  test('a failure cancels a running sibling branch and waits for it to stop', async () => {
    const probe = { aborted: [] as string[], settled: [] as string[] };
    const sibling = blocking('sibling', [], probe);
    const downstream = vi.fn((ctx: Ctx) => ctx);
    const terminals: string[] = [];
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'fail-cancels',
        nodes: [
          sibling.def,
          failing('broken', [], sibling.started),
          node('after-sibling', downstream, { dependsOn: ['sibling'], triggerRule: 'all_done' }),
        ],
      }),
      init(),
      { onStateChange: (c) => c.kind === 'terminal' && terminals.push(c.nodeName) },
    );
    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('broken failed');
    expect(probe.aborted).toEqual(['sibling']);
    // runPipeline resolved only after the sibling settled.
    expect(probe.settled).toEqual(['sibling']);
    expect(downstream).not.toHaveBeenCalled();
    expect(terminals).toEqual(['broken']);
  });

  test('the first failure is the one reported', async () => {
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'two-failures',
        nodes: [
          failing('first', [], Promise.resolve()),
          node<Ctx>(
            'second',
            (_ctx, signal) =>
              new Promise<Ctx>((_, reject) => {
                // Fails as it stops: that must not replace the first failure.
                signal.addEventListener('abort', () => reject(new Error('second failed')));
              }),
            { dependsOn: [] },
          ),
        ],
      }),
      init(),
    );
    expect(result.error).toBe('first failed');
  });

  test('a node that ignores its signal holds the run for stopGraceMs at most', async () => {
    const never = Promise.withResolvers<Ctx>();
    const started = Date.now();
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'uncooperative',
        nodes: [
          node<Ctx>('stubborn', () => never.promise, { dependsOn: [] }),
          failing('broken', [], Promise.resolve()),
        ],
      }),
      init(),
      { stopGraceMs: 30 },
    );
    expect(result.error).toBe('broken failed');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a failure with onError continue does not cancel its siblings', async () => {
    const finished: string[] = [];
    const slow: PipelineNode<Ctx> = node<Ctx>(
      'slow',
      async (ctx, signal) => {
        await new Promise((r) => setTimeout(r, 20));
        if (!signal.aborted) finished.push('slow');
        return ctx;
      },
      { dependsOn: [] },
    );
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'continue',
        nodes: [slow, failing('tolerated', [], Promise.resolve(), { onError: 'continue' })],
      }),
      init(),
    );
    expect(result.outcome).toBe('completed');
    expect(finished).toEqual(['slow']);
  });
});

describe('run cancellation', () => {
  test('aborting the run aborts every running node and waits for all of them', async () => {
    const probe = { aborted: [] as string[], settled: [] as string[] };
    const nodes = ['a', 'b', 'c'].map((n) => blocking(n, [], probe));
    const queued = vi.fn((ctx: Ctx) => ctx);
    const controller = new AbortController();
    const outcomes: string[] = [];
    const running = runPipeline(
      definePipeline<Ctx>({
        name: 'cancel-all',
        nodes: [...nodes.map((n) => n.def), node('queued', queued, { dependsOn: ['a'] })],
      }),
      init(),
      {
        signal: controller.signal,
        onStateChange: (c) => c.outcome && outcomes.push(c.outcome),
      },
    );
    await Promise.all(nodes.map((n) => n.started));
    controller.abort();
    const result = await running;
    expect(result.outcome).toBe('cancelled');
    expect(probe.aborted.sort()).toEqual(['a', 'b', 'c']);
    expect(probe.settled.sort()).toEqual(['a', 'b', 'c']);
    expect(queued).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['cancelled']);
  });
});
