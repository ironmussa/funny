/**
 * Batch groups: one execution of a node for several waiting runs.
 */
import { describe, expect, test } from 'bun:test';

import { definePipeline, node, runPipeline, type NodeRunInfo } from '../engine.js';
import { createMemoryConcurrencyGate, type ConcurrencyGate } from '../gate.js';
import { createMemoryJournal } from '../journal.js';

type Ctx = { run: string; outputs: Record<string, unknown> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a leader does with its batch; returns the leader's own context. */
type Lead = (ctx: Ctx, info: NodeRunInfo, signal: AbortSignal) => Promise<Ctx> | Ctx;

/** Settle every member as merged, recording who led. */
const mergeAll: Lead = (ctx, info) => {
  for (const m of info.batch?.members ?? []) {
    info.batch!.settle(m.holder, { status: 'succeeded', output: { mergedBy: ctx.run } });
  }
  return { ...ctx, outputs: { ...ctx.outputs, merge: { mergedBy: ctx.run } } };
};

function flow(leads: Lead[], led: string[], opts: { max?: number; waitMs?: number } = {}) {
  return definePipeline<Ctx>({
    name: 'merge-queue',
    nodes: [
      node<Ctx>(
        'merge',
        (ctx, signal, info) => {
          led.push(
            `${ctx.run}:${(info.batch?.members ?? []).map((m) => m.holder.split('/')[0]).join(',')}`,
          );
          return (leads.shift() ?? mergeAll)(ctx, info, signal);
        },
        {
          concurrency: {
            group: 'merge-funny',
            limit: 1,
            batch: {
              max: opts.max ?? 5,
              waitMs: opts.waitMs ?? 20,
              adopt: (input, output) => ({
                ...input,
                outputs: { ...input.outputs, merge: output },
              }),
            },
          },
        },
      ),
      node<Ctx>('after', (ctx) => ({ ...ctx, outputs: { ...ctx.outputs, after: true } })),
    ],
  });
}

const start = (
  gate: ConcurrencyGate,
  f: ReturnType<typeof flow>,
  run: string,
  signal?: AbortSignal,
) => runPipeline(f, { run, outputs: {} }, { gate, runId: run, signal });

describe('batch groups', () => {
  test('three waiting runs are merged as one batch, and each continues with its outcome', async () => {
    const gate = createMemoryConcurrencyGate();
    const led: string[] = [];
    const f = flow([], led);
    const results = await Promise.all(['r12', 'r13', 'r14'].map((r) => start(gate, f, r)));
    expect(led).toEqual(['r12:r13,r14']);
    for (const r of results) {
      expect(r.outcome).toBe('completed');
      expect(r.ctx.outputs).toEqual({ merge: { mergedBy: 'r12' }, after: true });
    }
  });

  test('a member that arrives within the wait joins the batch', async () => {
    const gate = createMemoryConcurrencyGate();
    const led: string[] = [];
    const f = flow([], led, { waitMs: 40 });
    const first = start(gate, f, 'a');
    await sleep(10);
    await Promise.all([first, start(gate, f, 'b')]);
    expect(led).toEqual(['a:b']);
  });

  test('a batch starts as soon as it is full, without waiting out the window', async () => {
    const gate = createMemoryConcurrencyGate();
    const led: string[] = [];
    const f = flow([], led, { max: 2, waitMs: 10_000 });
    const began = Date.now();
    const controller = new AbortController();
    const runs = ['a', 'b', 'c'].map((r) =>
      start(gate, f, r, r === 'c' ? controller.signal : undefined),
    );
    await Promise.all(runs.slice(0, 2));
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(led).toEqual(['a:b']);
    // c is alone now: it waits out the window for company; stop it.
    controller.abort();
    expect((await runs[2]).outcome).toBe('cancelled');
  });

  test('a member failed by the leader fails its own node, the others succeed', async () => {
    const gate = createMemoryConcurrencyGate();
    const f = flow(
      [
        (ctx, info) => {
          const [b, c] = info.batch!.members;
          info.batch!.settle(b.holder, { status: 'failed', error: 'conflicts with main' });
          info.batch!.settle(c.holder, { status: 'succeeded', output: { mergedBy: ctx.run } });
          return ctx;
        },
      ],
      [],
    );
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((r) => start(gate, f, r)));
    expect(a.outcome).toBe('completed');
    expect(b.outcome).toBe('failed');
    expect(b.error).toBe('conflicts with main');
    expect(b.ctx.outputs.after).toBeUndefined();
    expect(c.outcome).toBe('completed');
  });

  test('a requeued member waits again first in line, and leads the next batch', async () => {
    const gate = createMemoryConcurrencyGate();
    const led: string[] = [];
    const lateArrived = Promise.withResolvers<void>();
    const f = flow(
      [
        async (ctx, info) => {
          const [b] = info.batch!.members;
          info.batch!.settle(b.holder, { status: 'requeued' });
          // A run that arrives now queues behind the requeued one.
          await lateArrived.promise;
          return ctx;
        },
      ],
      led,
    );
    const a = start(gate, f, 'a');
    const b = start(gate, f, 'b');
    while (led.length === 0) await sleep(1);
    const c = start(gate, f, 'c');
    await sleep(5);
    lateArrived.resolve();
    const results = await Promise.all([a, b, c]);
    expect(results.map((r) => r.outcome)).toEqual(['completed', 'completed', 'completed']);
    expect(led).toEqual(['a:b', 'b:c']);
  });

  test('a cancelled member leaves the batch and the leader sees it cancelled', async () => {
    const gate = createMemoryConcurrencyGate();
    const controller = new AbortController();
    const states: string[] = [];
    const f = flow(
      [
        async (ctx, info) => {
          controller.abort();
          await sleep(1);
          for (const m of info.batch!.members) {
            info.batch!.settle(m.holder, { status: 'succeeded' });
            states.push(`${m.holder.split('/')[0]}:${m.state}`);
          }
          return ctx;
        },
      ],
      [],
    );
    const [, b, c] = await Promise.all([
      start(gate, f, 'a'),
      start(gate, f, 'b', controller.signal),
      start(gate, f, 'c'),
    ]);
    expect(b.outcome).toBe('cancelled');
    expect(c.outcome).toBe('completed');
    expect(states).toEqual(['b:cancelled', 'c:succeeded']);
  });

  test('when the leader run is cancelled, its members wait again and a new leader takes them', async () => {
    const gate = createMemoryConcurrencyGate();
    const controller = new AbortController();
    const led: string[] = [];
    const f = flow(
      [
        (_ctx, _info, signal) =>
          new Promise<Ctx>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('stopped')));
            controller.abort();
          }),
      ],
      led,
    );
    const [a, b, c] = await Promise.all([
      start(gate, f, 'a', controller.signal),
      start(gate, f, 'b'),
      start(gate, f, 'c'),
    ]);
    expect(a.outcome).toBe('cancelled');
    expect([b.outcome, c.outcome]).toEqual(['completed', 'completed']);
    expect(led).toEqual(['a:b,c', 'b:c']);
    expect(b.ctx.outputs.merge).toEqual({ mergedBy: 'b' });
    expect(c.ctx.outputs.merge).toEqual({ mergedBy: 'b' });
  });

  test('members a leader ends without settling wait again', async () => {
    const gate = createMemoryConcurrencyGate();
    const led: string[] = [];
    const f = flow([(ctx) => ctx], led);
    await Promise.all(['a', 'b'].map((r) => start(gate, f, r)));
    expect(led).toEqual(['a:b', 'b:']);
  });

  test('a member outcome is journaled under the member run', async () => {
    const gate = createMemoryConcurrencyGate();
    const journal = createMemoryJournal<Ctx>();
    const f = flow([], []);
    await Promise.all(
      ['a', 'b'].map((run) => runPipeline(f, { run, outputs: {} }, { gate, journal, runId: run })),
    );
    const b = journal.entries('b').filter((e) => e.nodeId === 'merge');
    expect(b.map((e) => e.status)).toEqual(['succeeded']);
    expect(b[0].output?.outputs.merge).toEqual({ mergedBy: 'a' });
  });
});
