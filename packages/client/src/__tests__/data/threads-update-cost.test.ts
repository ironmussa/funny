import type { Thread } from '@funny/shared';
import { createLiveQueryCollection, inArray } from '@tanstack/db';
import { describe, expect, test } from 'vitest';

import { createDataLayer } from '@/data/data-layer';
import { getThreadsData } from '@/data/threads/store';
import { groupThreadsByStage } from '@/data/threads/views';

/**
 * Update-cost benchmark (openspec adopt-tanstack-db-client, task 3.4):
 * sidebar + Kanban derivation with 500 threads while 10 agents stream.
 *
 * Opt-in, because wall-clock assertions are flaky on shared CI runners:
 *   FUNNY_BENCH=1 bunx vitest run --project unit src/__tests__/data/threads-update-cost.test.ts
 *
 * Measures the data layer path: one synced commit per frame (as the realtime
 * rAF flush does) + a live query over the listed IDs + Kanban grouping.
 *
 * Reference, measured in phase 3 on the same scenario before the legacy
 * Zustand index was removed: legacy ≈0.15–0.17 ms/frame; data layer ≈0.42–0.50
 * ms/frame after write coalescing (≈0.6 ms/frame without it).
 */

const THREADS = 500;
const PROJECTS = 5;
const STREAMING = 10;
const FRAMES = 200;

function makeThreads(): Thread[] {
  return Array.from({ length: THREADS }, (_, i) => ({
    id: `t${i}`,
    projectId: `p${i % PROJECTS}`,
    title: `thread ${i}`,
    mode: 'local',
    status: i < STREAMING ? 'running' : 'completed',
    stage: (['backlog', 'planning', 'in_progress', 'review', 'done'] as const)[i % 5],
    cost: 0,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  })) as Thread[];
}

function frameUpdate(thread: Thread, frame: number): Thread {
  return { ...thread, lastAssistantMessage: `chunk ${frame}`, cost: thread.cost + 0.001 };
}

/** `setup` builds the store; only the returned frame loop is timed. */
function timeIt(setup: () => { frames: () => void; teardown?: () => void }): number {
  const warm = setup();
  warm.frames();
  warm.teardown?.();
  const run = setup();
  const start = performance.now();
  run.frames();
  const elapsed = performance.now() - start;
  run.teardown?.();
  return elapsed;
}

function dataLayerRun(threads: Thread[]) {
  return () => {
    const layer = createDataLayer({ userId: 'bench' });
    const data = getThreadsData(layer);
    data.upsertFromServer(threads, data.beginRequest());
    const ids = threads.map((t) => t.id);
    const live = createLiveQueryCollection((q) =>
      q.from({ thread: data.collection }).where(({ thread }) => inArray(thread.id, ids)),
    );
    live.startSyncImmediate();
    return {
      frames: () => {
        for (let frame = 0; frame < FRAMES; frame++) {
          // One commit per frame, as the realtime rAF flush does.
          data.batchWrites(() => {
            for (let i = 0; i < STREAMING; i++) {
              data.patchSynced(`t${i}`, (t) => frameUpdate(t, frame));
            }
          });
          groupThreadsByStage(live.toArray.map((row) => data.fromRow(row as Thread)));
        }
      },
      teardown: () => {
        void live.cleanup();
        layer.dispose();
      },
    };
  };
}

describe.runIf(process.env.FUNNY_BENCH === '1')(
  'thread update cost (500 threads, 10 streaming)',
  () => {
    test('data layer stays well inside one frame', () => {
      const threads = makeThreads();
      const dataMs = timeIt(dataLayerRun(threads));
      // Reported for the PR description (the unit setup silences console).
      process.stdout.write(
        `[bench] data layer ${dataMs.toFixed(1)}ms (${(dataMs / FRAMES).toFixed(3)}ms/frame)\n`,
      );
      expect(dataMs / FRAMES).toBeLessThan(16);
    });
  },
);
