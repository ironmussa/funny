/**
 * Early integration (openspec factory-integration 5.1, D8): when the base
 * moves, a run whose change overlaps it and whose pull request no longer
 * merges integrates then, outside its flow, never while a step holds its
 * checkout, and never once it is at merge.
 */
import { describe, expect, test } from 'bun:test';

import type { ActionResult } from '@funny/workflows/compiler';

import {
  createEarlyIntegration,
  createWorkspaceLock,
} from '../../../services/factory/factory-early-integration.js';
import {
  integrateEarly,
  type EarlyCandidate,
} from '../../../services/factory/factory-early-watch.js';

const merged: ActionResult = { ok: true, output: 'merged', metadata: { outcome: 'merged' } };
const conflict: ActionResult = {
  ok: true,
  output: 'conflict',
  metadata: { outcome: 'conflict', feedback: 'src/a.ts conflicts' },
};

function early(over: { result?: ActionResult; atMerge?: boolean; now?: () => number } = {}) {
  const lock = createWorkspaceLock();
  const log: string[] = [];
  const handle = createEarlyIntegration({
    lock,
    integrate: async () => {
      log.push('integrate');
      return over.result ?? merged;
    },
    atMerge: () => over.atMerge ?? false,
    toImplementer: async (feedback) => {
      log.push(`agent: ${feedback}`);
    },
    markPending: async (at) => {
      log.push(at ? 'pending' : 'pending cleared');
    },
    now: over.now,
  });
  return { lock, handle, log };
}

describe('the early integration of one run', () => {
  test('in ci or review no step holds the checkout: it integrates at once', async () => {
    const { handle, log } = early();
    expect(await handle.request()).toBe('integrated');
    expect(log).toEqual(['integrate']);
  });

  test('while the implementer works it waits, then runs before the next step', async () => {
    const { lock, handle, log } = early();
    let finish!: () => void;
    const implementing = lock.hold(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            log.push('implementer done');
            resolve();
          };
        }),
      () => handle.afterStep(),
    );
    expect(await handle.request()).toBe('pending');
    // Asked twice while pending: still one integration.
    expect(await handle.request()).toBe('pending');
    const next = lock.hold(async () => {
      log.push('next step');
    });
    finish();
    await implementing;
    await next;
    expect(log).toEqual([
      'pending',
      'implementer done',
      'pending cleared',
      'integrate',
      'next step',
    ]);
  });

  test('a run at merge is left to the queue', async () => {
    const { handle, log } = early({ atMerge: true });
    expect(await handle.request()).toBe('skipped');
    expect(log).toEqual([]);
  });

  test('at most once in ten minutes', async () => {
    let clock = 0;
    const { handle } = early({ now: () => clock });
    expect(await handle.request()).toBe('integrated');
    clock = 5 * 60_000;
    expect(await handle.request()).toBe('skipped');
    clock = 11 * 60_000;
    expect(await handle.request()).toBe('integrated');
  });

  test('a conflict goes to the implementer while it still has the context', async () => {
    const { handle, log } = early({ result: conflict });
    expect(await handle.request()).toBe('sent-to-agent');
    expect(log).toEqual(['integrate', 'agent: src/a.ts conflicts']);
  });
});

describe('which runs integrate early', () => {
  function watch(opts: {
    heads: string[];
    changed?: string[];
    candidates: EarlyCandidate[];
    mergeable?: Record<number, boolean | null>;
  }) {
    const lastBase = new Map<string, string>();
    const asked: string[] = [];
    const heads = [...opts.heads];
    const deps = {
      lastBase,
      key: 'f1:o/r',
      head: async () => heads.shift() ?? null,
      changedPaths: async () => opts.changed ?? [],
      candidates: async () => opts.candidates,
      mergeable: async (pr: number) => opts.mergeable?.[pr] ?? true,
      integrate: async (runId: string) => {
        asked.push(runId);
        return 'integrated' as const;
      },
    };
    return { deps, asked };
  }

  test('the first look only learns where the base is', async () => {
    const { deps, asked } = watch({
      heads: ['b1'],
      candidates: [{ runId: 'r1', prNumber: 1, paths: ['src/a.ts'] }],
      mergeable: { 1: false },
    });
    expect(await integrateEarly(deps)).toEqual([]);
    expect(asked).toEqual([]);
  });

  test('an overlapping run that no longer merges integrates; one that still merges or does not overlap does not', async () => {
    const { deps, asked } = watch({
      heads: ['b1', 'b2'],
      changed: ['src/a.ts', 'bun.lock'],
      candidates: [
        { runId: 'overlap-conflicts', prNumber: 1, paths: ['src/a.ts'] },
        { runId: 'overlap-merges', prNumber: 2, paths: ['bun.lock'] },
        { runId: 'elsewhere', prNumber: 3, paths: ['docs/x.md'] },
        { runId: 'computing', prNumber: 4, paths: ['src/a.ts'] },
      ],
      mergeable: { 1: false, 2: true, 3: false, 4: null },
    });
    await integrateEarly(deps);
    expect(await integrateEarly(deps)).toEqual([
      { runId: 'overlap-conflicts', outcome: 'integrated' },
    ]);
    expect(asked).toEqual(['overlap-conflicts']);
  });

  test('a base that did not move asks nothing', async () => {
    const { deps, asked } = watch({
      heads: ['b1', 'b1'],
      changed: ['src/a.ts'],
      candidates: [{ runId: 'r1', prNumber: 1, paths: ['src/a.ts'] }],
      mergeable: { 1: false },
    });
    await integrateEarly(deps);
    await integrateEarly(deps);
    expect(asked).toEqual([]);
  });
});
