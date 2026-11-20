/**
 * The execution journal: recording, and resuming without repeating work.
 */
import { describe, expect, test, vi } from 'vitest';

import { definePipeline, node, runPipeline, type PipelineNode } from '../engine.js';
import { createMemoryJournal, type JournalEntry } from '../journal.js';

type Ctx = { outputs: Record<string, unknown> };
const init = (): Ctx => ({ outputs: {} });

const writes = (name: string, value: unknown) => (ctx: Ctx) => ({
  ...ctx,
  outputs: { ...ctx.outputs, [name]: value },
});

const entry = (e: Partial<JournalEntry<Ctx>> & Pick<JournalEntry<Ctx>, 'nodeId' | 'status'>) =>
  ({ runId: 'run-1', visit: '1', attempt: 1, startedAt: 1, ...e }) as JournalEntry<Ctx>;

describe('journal', () => {
  test('records each execution when it starts and when it ends', async () => {
    const journal = createMemoryJournal<Ctx>();
    const seen: string[] = [];
    const record = journal.record;
    journal.record = async (e) => {
      seen.push(`${e.nodeId}:${e.status}`);
      await record(e);
    };
    await runPipeline(
      definePipeline<Ctx>({
        name: 'rec',
        nodes: [node('a', writes('a', 1)), node('b', writes('b', 2))],
      }),
      init(),
      { journal, runId: 'run-1' },
    );
    expect(seen).toEqual(['a:running', 'a:succeeded', 'b:running', 'b:succeeded']);
    const b = journal.entries('run-1').find((e) => e.nodeId === 'b')!;
    expect(b).toMatchObject({ visit: '1', attempt: 1, status: 'succeeded' });
    expect(b.output?.outputs).toEqual({ a: 1, b: 2 });
    expect(b.finishedAt).toBeGreaterThanOrEqual(b.startedAt);
  });

  test('resume after a restart with parallel branches', async () => {
    // The previous process recorded `done` as succeeded and died while `agent` was running.
    const journal = createMemoryJournal<Ctx>();
    await journal.record(
      entry({ nodeId: 'done', status: 'succeeded', output: { outputs: { done: 'recorded' } } }),
    );
    await journal.record(entry({ nodeId: 'agent', status: 'running', data: { threadId: 't-1' } }));

    const done = vi.fn(writes('done', 'fresh'));
    const resumes: unknown[] = [];
    const result = await runPipeline(
      definePipeline<Ctx>({
        name: 'parallel',
        nodes: [
          node('done', done, { dependsOn: [] }),
          node<Ctx>(
            'agent',
            (ctx, _signal, info) => {
              resumes.push(info.resume?.recorded.data);
              return writes('agent', 'adopted')(ctx);
            },
            { dependsOn: [] },
          ),
          node('join', (ctx: Ctx) => ctx, { dependsOn: ['done', 'agent'] }),
        ],
      }),
      init(),
      { journal, runId: 'run-1' },
    );
    expect(result.outcome).toBe('completed');
    expect(done).not.toHaveBeenCalled();
    expect(resumes).toEqual([{ threadId: 't-1' }]);
    expect(result.ctx.outputs).toEqual({ done: 'recorded', agent: 'adopted' });
    const agent = journal.entries('run-1').filter((e) => e.nodeId === 'agent');
    expect(agent.map((e) => [e.attempt, e.status])).toEqual([
      [1, 'running'],
      [2, 'succeeded'],
    ]);
  });

  test('a checkpoint is what a resumed execution receives', async () => {
    const journal = createMemoryJournal<Ctx>();
    const controller = new AbortController();
    const agentNode = (onRun: (data: unknown) => void): PipelineNode<Ctx> =>
      node<Ctx>('agent', async (ctx, signal, info) => {
        onRun(info.resume?.recorded.data);
        if (info.resume) return writes('agent', 'adopted')(ctx);
        await info.checkpoint({ threadId: 't-9' });
        controller.abort();
        signal.throwIfAborted();
        return ctx;
      });
    const first: unknown[] = [];
    const interrupted = await runPipeline(
      definePipeline<Ctx>({ name: 'cp', nodes: [agentNode((d) => first.push(d))] }),
      init(),
      { journal, runId: 'run-1', signal: controller.signal },
    );
    expect(interrupted.outcome).toBe('cancelled');
    const second: unknown[] = [];
    const resumed = await runPipeline(
      definePipeline<Ctx>({ name: 'cp', nodes: [agentNode((d) => second.push(d))] }),
      init(),
      { journal, runId: 'run-1' },
    );
    expect(first).toEqual([undefined]);
    expect(second).toEqual([{ threadId: 't-9' }]);
    expect(resumed.ctx.outputs).toEqual({ agent: 'adopted' });
  });

  test('resume inside a loop does not repeat the first visit', async () => {
    const journal = createMemoryJournal<Ctx>();
    const runs: string[] = [];
    const flow = (stopAtVisit: number | undefined, controller?: AbortController) =>
      definePipeline<Ctx>({
        name: 'loop',
        nodes: [
          node('setup', (ctx: Ctx) => {
            runs.push('setup');
            return ctx;
          }),
          node<Ctx>(
            'work',
            async (ctx, signal, info) => {
              runs.push(`work@${info.visit}${info.resume ? ':resumed' : ''}`);
              if (info.iteration === stopAtVisit) {
                controller?.abort();
                signal.throwIfAborted();
              }
              return writes('visits', info.iteration)(ctx);
            },
            { loop: { backTo: 'work', until: (ctx) => ctx.outputs.visits === 3 } },
          ),
        ],
      });
    const controller = new AbortController();
    const first = await runPipeline(flow(2, controller), init(), {
      journal,
      runId: 'run-1',
      signal: controller.signal,
    });
    expect(first.outcome).toBe('cancelled');
    const resumed = await runPipeline(flow(undefined), init(), { journal, runId: 'run-1' });
    expect(resumed.outcome).toBe('completed');
    expect(resumed.iterations).toBe(3);
    expect(runs).toEqual(['setup', 'work@1', 'work@2', 'work@2:resumed', 'work@3']);
  });

  test('nested loops key executions by the full visit path', async () => {
    const journal = createMemoryJournal<Ctx>();
    let outer = 0;
    await runPipeline(
      definePipeline<Ctx>({
        name: 'nested',
        nodes: [
          node('implement', writes('implement', true), { dependsOn: [] }),
          node<Ctx>('ci', (ctx, _s, info) => writes('ci', info.iteration)(ctx), {
            dependsOn: ['implement'],
            loop: { backTo: 'implement', until: (ctx) => ctx.outputs.ci === 2 },
          }),
          node<Ctx>('merge', (ctx) => writes('merge', ++outer)(ctx), {
            dependsOn: ['ci'],
            loop: { backTo: 'implement', until: (ctx) => ctx.outputs.merge === 2 },
          }),
        ],
      }),
      init(),
      { journal, runId: 'run-1' },
    );
    const ci = journal
      .entries('run-1')
      .filter((e) => e.nodeId === 'ci' && e.status === 'succeeded')
      .map((e) => e.visit);
    expect(ci).toEqual(['1.1', '1.2', '2.1', '2.2']);
  });

  test('a failure that ended the previous attempt runs again; a tolerated one is kept', async () => {
    const journal = createMemoryJournal<Ctx>();
    await journal.record(
      entry({ nodeId: 'flaky', status: 'failed', error: 'boom', output: init() }),
    );
    await journal.record(
      entry({ nodeId: 'optional', status: 'failed', error: 'meh', output: init() }),
    );
    const flaky = vi.fn(writes('flaky', 'ok'));
    const optional = vi.fn(writes('optional', 'ok'));
    const after = vi.fn((ctx: Ctx) => ctx);
    await runPipeline(
      definePipeline<Ctx>({
        name: 'failures',
        nodes: [
          node('flaky', flaky, { dependsOn: [] }),
          node('optional', optional, { dependsOn: [], onError: 'continue' }),
          node('after', after, { dependsOn: ['optional'] }),
        ],
      }),
      init(),
      { journal, runId: 'run-1' },
    );
    expect(flaky).toHaveBeenCalledTimes(1);
    expect(optional).not.toHaveBeenCalled();
    // The tolerated failure still skips its all_success dependent.
    expect(after).not.toHaveBeenCalled();
  });

  test('a journal that cannot be read fails the run before any node runs', async () => {
    const a = vi.fn((ctx: Ctx) => ctx);
    const result = await runPipeline(
      definePipeline<Ctx>({ name: 'broken', nodes: [node('a', a)] }),
      init(),
      {
        runId: 'run-1',
        journal: { load: async () => Promise.reject(new Error('db down')), record: async () => {} },
      },
    );
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/db down/);
    expect(a).not.toHaveBeenCalled();
  });
});
