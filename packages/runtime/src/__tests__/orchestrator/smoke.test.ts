/**
 * Phase 0 smoke test for the orchestrator integration.
 *
 * Goal: prove that the foundational primitives the orchestrator will
 * lean on (`runPipeline`, state-change events, abort propagation) work
 * standalone without going through the runtime's `pipeline-manager`.
 *
 * Scope is intentionally narrow — no DB, no WS broker, no
 * ActionProvider. Those layers are exercised in later phases.
 */

import { definePipeline, node, runPipeline, type PipelineStateChange } from '@funny/pipelines';
import { describe, expect, test } from 'vitest';

interface SmokeCtx {
  count: number;
  trail: string[];
}

describe('orchestrator smoke — runPipeline standalone', () => {
  test('runs nodes sequentially and emits ordered state changes', async () => {
    const events: PipelineStateChange<SmokeCtx>[] = [];

    const pipeline = definePipeline<SmokeCtx>({
      name: 'smoke-sequential',
      nodes: [
        node<SmokeCtx>('first', (ctx) => ({
          count: ctx.count + 1,
          trail: [...ctx.trail, 'first'],
        })),
        node<SmokeCtx>('second', (ctx) => ({
          count: ctx.count + 10,
          trail: [...ctx.trail, 'second'],
        })),
      ],
    });

    const result = await runPipeline(
      pipeline,
      { count: 0, trail: [] },
      {
        onStateChange: (change) => events.push(change),
      },
    );

    expect(result.outcome).toBe('completed');
    expect(result.ctx.count).toBe(11);
    expect(result.ctx.trail).toEqual(['first', 'second']);

    const kinds = events.map((e) => `${e.kind}:${e.nodeName}`);
    expect(kinds).toEqual([
      'entering:first',
      'completed:first',
      'entering:second',
      'completed:second',
      'terminal:second',
    ]);
    expect(events.at(-1)?.outcome).toBe('completed');
  });

  test('AbortSignal short-circuits before the next node runs', async () => {
    const ctrl = new AbortController();
    const events: PipelineStateChange<SmokeCtx>[] = [];

    const pipeline = definePipeline<SmokeCtx>({
      name: 'smoke-abort',
      nodes: [
        node<SmokeCtx>('start', (ctx) => {
          ctrl.abort();
          return { count: ctx.count + 1, trail: [...ctx.trail, 'start'] };
        }),
        node<SmokeCtx>('never', (ctx) => ({
          count: ctx.count + 100,
          trail: [...ctx.trail, 'never'],
        })),
      ],
    });

    const result = await runPipeline(
      pipeline,
      { count: 0, trail: [] },
      {
        signal: ctrl.signal,
        onStateChange: (change) => events.push(change),
      },
    );

    expect(result.outcome).toBe('cancelled');
    expect(result.ctx.trail).toEqual(['start']);
    // 'never' must not have been entered or completed — only the
    // terminal:cancelled event may reference it as the next-up node.
    expect(events.some((e) => e.nodeName === 'never' && e.kind !== 'terminal')).toBe(false);
    expect(events.at(-1)?.outcome).toBe('cancelled');
  });

  test('per-node retry recovers from transient failures', async () => {
    let attempts = 0;
    const pipeline = definePipeline<SmokeCtx>({
      name: 'smoke-retry',
      nodes: [
        node<SmokeCtx>(
          'flaky',
          (ctx) => {
            attempts++;
            if (attempts < 3) throw new Error('transient');
            return { count: ctx.count + 1, trail: [...ctx.trail, 'flaky'] };
          },
          { retry: { maxAttempts: 5, delayMs: 0 } },
        ),
      ],
    });

    const result = await runPipeline(pipeline, { count: 0, trail: [] });

    expect(result.outcome).toBe('completed');
    expect(attempts).toBe(3);
    expect(result.ctx.count).toBe(1);
  });

  test('node failure surfaces as terminal:failed outcome', async () => {
    const events: PipelineStateChange<SmokeCtx>[] = [];

    const pipeline = definePipeline<SmokeCtx>({
      name: 'smoke-fail',
      nodes: [
        node<SmokeCtx>('boom', () => {
          throw new Error('kaboom');
        }),
      ],
    });

    const result = await runPipeline(
      pipeline,
      { count: 0, trail: [] },
      {
        onStateChange: (change) => events.push(change),
      },
    );

    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('kaboom');
    expect(events.at(-1)?.outcome).toBe('failed');
  });
});
