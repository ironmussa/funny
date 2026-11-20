/**
 * Concurrency groups across runs, through the ConcurrencyGate port.
 */
import { describe, expect, test, vi } from 'vitest';

import { definePipeline, node, runPipeline, type PipelineStateChange } from '../engine.js';
import { createMemoryConcurrencyGate } from '../gate.js';

type Ctx = { repo: string; outputs: Record<string, unknown> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A flow whose `merge` node is limited to one per repository. */
function mergeFlow(log: string[], merge = async (ctx: Ctx) => ctx) {
  return definePipeline<Ctx>({
    name: 'merge-flow',
    nodes: [
      node<Ctx>(
        'merge',
        async (ctx, signal) => {
          log.push(`start:${ctx.repo}:${ctx.outputs.run}`);
          await sleep(20);
          signal.throwIfAborted();
          const out = await merge(ctx);
          log.push(`end:${ctx.repo}:${ctx.outputs.run}`);
          return out;
        },
        { concurrency: { group: (ctx) => `merge-${ctx.repo}`, limit: 1 } },
      ),
    ],
  });
}

const ctx = (repo: string, run: string): Ctx => ({ repo, outputs: { run } });

describe('concurrency groups', () => {
  test('one merge at a time per repository; the waiter starts when the first ends', async () => {
    const gate = createMemoryConcurrencyGate();
    const log: string[] = [];
    const kinds: string[] = [];
    const onStateChange = (c: PipelineStateChange<Ctx>) =>
      kinds.push(`${c.kind}:${c.ctx.outputs.run}`);
    const [a, b] = await Promise.all([
      runPipeline(mergeFlow(log), ctx('funny', '12'), { gate, onStateChange }),
      runPipeline(mergeFlow(log), ctx('funny', '13'), { gate, onStateChange }),
    ]);
    expect([a.outcome, b.outcome]).toEqual(['completed', 'completed']);
    expect(log).toEqual(['start:funny:12', 'end:funny:12', 'start:funny:13', 'end:funny:13']);
    expect(kinds).toContain('waiting_slot:13');
    expect(kinds).not.toContain('waiting_slot:12');
  });

  test('different repositories do not wait for each other', async () => {
    const gate = createMemoryConcurrencyGate();
    const log: string[] = [];
    await Promise.all([
      runPipeline(mergeFlow(log), ctx('funny', '1'), { gate }),
      runPipeline(mergeFlow(log), ctx('other', '2'), { gate }),
    ]);
    expect(log.slice(0, 2).sort()).toEqual(['start:funny:1', 'start:other:2']);
  });

  test('a run cancelled while waiting leaves the queue and never enters the node', async () => {
    const gate = createMemoryConcurrencyGate();
    const log: string[] = [];
    const controller = new AbortController();
    const kinds: string[] = [];
    const first = runPipeline(mergeFlow(log), ctx('funny', '1'), { gate });
    const waiting = runPipeline(mergeFlow(log), ctx('funny', '2'), {
      gate,
      signal: controller.signal,
      onStateChange: (c) => {
        kinds.push(c.kind);
        if (c.kind === 'waiting_slot') controller.abort();
      },
    });
    const third = runPipeline(mergeFlow(log), ctx('funny', '3'), { gate });
    expect((await waiting).outcome).toBe('cancelled');
    await Promise.all([first, third]);
    expect(kinds).toEqual(['waiting_slot', 'terminal']);
    expect(log).toEqual(['start:funny:1', 'end:funny:1', 'start:funny:3', 'end:funny:3']);
  });

  test('a failed holder releases its slot', async () => {
    const gate = createMemoryConcurrencyGate();
    const log: string[] = [];
    const failing = mergeFlow(log, async () => {
      throw new Error('merge conflict');
    });
    const [a, b] = await Promise.all([
      runPipeline(failing, ctx('funny', '1'), { gate }),
      runPipeline(mergeFlow(log), ctx('funny', '2'), { gate }),
    ]);
    expect(a.outcome).toBe('failed');
    expect(b.outcome).toBe('completed');
  });

  test('a cancelled holder releases its slot only after its work stopped', async () => {
    const gate = createMemoryConcurrencyGate();
    const log: string[] = [];
    const controller = new AbortController();
    const holding = definePipeline<Ctx>({
      name: 'holding',
      nodes: [
        node<Ctx>(
          'merge',
          (_ctx, signal) =>
            new Promise<Ctx>((_, reject) => {
              log.push('start:holder');
              signal.addEventListener('abort', () =>
                setTimeout(() => {
                  log.push('stopped:holder');
                  reject(new Error('stopped'));
                }, 15),
              );
            }),
          { concurrency: { group: 'merge-funny', limit: 1 } },
        ),
      ],
    });
    const holder = runPipeline(holding, ctx('funny', 'h'), { gate, signal: controller.signal });
    while (!log.includes('start:holder')) await sleep(1);
    const next = runPipeline(mergeFlow(log), ctx('funny', 'n'), {
      gate,
      onStateChange: (c) => c.kind === 'waiting_slot' && controller.abort(),
    });
    await Promise.all([holder, next]);
    expect(log).toEqual(['start:holder', 'stopped:holder', 'start:funny:n', 'end:funny:n']);
  });

  test('a node skipped by its guard never asks for a slot', async () => {
    const acquire = vi.fn();
    await runPipeline(
      definePipeline<Ctx>({
        name: 'guarded',
        nodes: [
          node<Ctx>('merge', (c) => c, {
            when: () => false,
            concurrency: { group: 'g', limit: 1 },
          }),
        ],
      }),
      ctx('funny', '1'),
      { gate: { acquire } },
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  test('the group comes from the initial context and the holder names run, node and visit', async () => {
    const requests: { group: string; holder: string; limit: number }[] = [];
    const gate = {
      acquire: vi.fn(async (r: { group: string; holder: string; limit: number }) => {
        requests.push({ group: r.group, holder: r.holder, limit: r.limit });
        return { kind: 'slot' as const, release: () => {} };
      }),
    };
    await runPipeline(
      definePipeline<Ctx>({
        name: 'holder',
        nodes: [
          node<Ctx>('rename', (c) => ({ ...c, repo: 'changed' })),
          node<Ctx>('merge', (c) => c, {
            concurrency: { group: (c) => `merge-${c.repo}`, limit: 2 },
          }),
        ],
      }),
      ctx('funny', '1'),
      { gate, runId: 'run-7' },
    );
    expect(requests).toEqual([{ group: 'merge-funny', holder: 'run-7/merge/1', limit: 2 }]);
  });

  test('the host can replace the limit', async () => {
    const gate = createMemoryConcurrencyGate({ resolveLimit: () => 2 });
    const log: string[] = [];
    await Promise.all(
      ['1', '2', '3'].map((r) => runPipeline(mergeFlow(log), ctx('funny', r), { gate })),
    );
    expect(log.slice(0, 2).every((l) => l.startsWith('start'))).toBe(true);
    expect(log[2]).toMatch(/^end/);
  });

  test('the host orders waiters by priority', async () => {
    const gate = createMemoryConcurrencyGate({
      priority: (holder) => (holder.startsWith('urgent') ? 0 : 1),
    });
    const log: string[] = [];
    const first = runPipeline(mergeFlow(log), ctx('funny', 'first'), { gate, runId: 'a' });
    await sleep(1);
    const late = runPipeline(mergeFlow(log), ctx('funny', 'late'), { gate, runId: 'b' });
    const urgent = runPipeline(mergeFlow(log), ctx('funny', 'urgent'), { gate, runId: 'urgent' });
    await Promise.all([first, late, urgent]);
    expect(log.filter((l) => l.startsWith('start'))).toEqual([
      'start:funny:first',
      'start:funny:urgent',
      'start:funny:late',
    ]);
  });
});
