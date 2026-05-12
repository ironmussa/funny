/**
 * Phase 3 integration tests for OrchestratorService.
 *
 * These tests exercise the full tick path against an in-memory SQLite
 * database with a mock dispatcher and emitter. The pipeline executor
 * is intentionally NOT involved — that wiring lands in Phase 4.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import { dbAll, dbGet, dbRun } from '@funny/shared/db/connection';
import { createOrchestratorRunRepository } from '@funny/shared/repositories';
import {
  OrchestratorService,
  defaultOrchestratorConfig,
  type DispatchHandle,
  type DispatchResult,
  type Dispatcher,
  type OrchestratorEmitter,
  type OrchestratorLogger,
  type ThreadQueryAdapter,
} from '@funny/thread-orchestrator';

import { createThreadQuery } from '../../services/orchestrator-thread-query.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

// ── Helpers ───────────────────────────────────────────────────

const silentLog: OrchestratorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface RecordedEvent {
  userId: string;
  type: string;
  data: Record<string, unknown>;
}

function makeEmitter(): OrchestratorEmitter & { events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  return {
    events,
    emitToUser: (userId, type, data) => {
      events.push({ userId, type, data });
    },
  };
}

interface MockHandle extends DispatchHandle {
  resolve: (
    outcome: { kind: 'completed' } | { kind: 'failed'; error: string } | { kind: 'cancelled' },
  ) => void;
  aborted: boolean;
}

function makeMockDispatcher(): Dispatcher & {
  handles: MockHandle[];
  nextResult: DispatchResult | null;
} {
  const handles: MockHandle[] = [];
  return {
    handles,
    nextResult: null,
    async dispatch(_thread): Promise<DispatchResult> {
      const self = this as unknown as { nextResult: DispatchResult | null };
      if (self.nextResult) {
        const r = self.nextResult;
        self.nextResult = null;
        return r;
      }
      let resolveFn!: MockHandle['resolve'];
      const finished = new Promise<
        { kind: 'completed' } | { kind: 'failed'; error: string } | { kind: 'cancelled' }
      >((resolve) => {
        resolveFn = resolve;
      });
      const handle: MockHandle = {
        pipelineRunId: `run-${handles.length + 1}`,
        aborted: false,
        abort: () => {
          handle.aborted = true;
        },
        finished,
        resolve: resolveFn,
      };
      handles.push(handle);
      return { ok: true, handle };
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────

let testDb: ReturnType<typeof createTestDb>;
let runRepo: ReturnType<typeof createOrchestratorRunRepository>;
let threadQuery: ThreadQueryAdapter;
let emitter: ReturnType<typeof makeEmitter>;
let dispatcher: ReturnType<typeof makeMockDispatcher>;

beforeEach(() => {
  testDb = createTestDb();
  runRepo = createOrchestratorRunRepository({
    db: testDb.db as any,
    schema: testDb.schema as any,
    dbAll,
    dbGet,
    dbRun,
  });
  threadQuery = createThreadQuery({ db: testDb.db as any, schema: testDb.schema as any });
  emitter = makeEmitter();
  dispatcher = makeMockDispatcher();
  seedProject(testDb.db, { id: 'p1', userId: 'user-1' });
});

function makeService(
  overrides: Partial<typeof defaultOrchestratorConfig> = {},
  now?: () => number,
) {
  return new OrchestratorService({
    runRepo,
    threadQuery,
    dispatcher,
    emitter,
    config: { ...defaultOrchestratorConfig, enabled: true, ...overrides },
    log: silentLog,
    now,
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe('OrchestratorService.refresh', () => {
  test('dispatches an eligible thread and writes orchestrator_runs', async () => {
    seedThread(testDb.db, {
      id: 't1',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const svc = makeService();
    const summary = await svc.refresh();

    expect(summary.candidatesCount).toBe(1);
    expect(summary.dispatchedCount).toBe(1);
    expect(dispatcher.handles).toHaveLength(1);

    const row = await runRepo.getRun('t1');
    expect(row?.userId).toBe('user-1');
    expect(row?.pipelineRunId).toBe('run-1');

    const types = emitter.events.map((e) => e.type);
    expect(types).toContain('thread:claimed');
    expect(types).toContain('thread:dispatched');
    expect(types).toContain('orchestrator:tick');
  });

  test('respects maxConcurrentGlobal and does not over-dispatch', async () => {
    for (let i = 1; i <= 4; i++) {
      seedThread(testDb.db, {
        id: `t${i}`,
        projectId: 'p1',
        userId: 'user-1',
        stage: 'in_progress',
        status: 'pending',
        createdAt: `2026-01-0${i}T00:00:00Z`,
      });
    }

    const svc = makeService({ maxConcurrentGlobal: 2, maxConcurrentPerUser: 5 });
    const summary = await svc.refresh();

    expect(summary.candidatesCount).toBe(4);
    expect(summary.dispatchedCount).toBe(2);
    expect(dispatcher.handles).toHaveLength(2);

    const rows = await runRepo.listActiveRuns();
    expect(rows.map((r) => r.threadId).sort()).toEqual(['t1', 't2']);
  });

  test('respects maxConcurrentPerUser across users', async () => {
    seedProject(testDb.db, { id: 'p2', userId: 'user-2' });
    seedThread(testDb.db, {
      id: 'a1',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
    });
    seedThread(testDb.db, {
      id: 'a2',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-02T00:00:00Z',
    });
    seedThread(testDb.db, {
      id: 'b1',
      projectId: 'p2',
      userId: 'user-2',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-03T00:00:00Z',
    });

    const svc = makeService({ maxConcurrentGlobal: 10, maxConcurrentPerUser: 1 });
    const summary = await svc.refresh();

    expect(summary.dispatchedCount).toBe(2);
    const rows = await runRepo.listActiveRuns();
    const ids = rows.map((r) => r.threadId).sort();
    expect(ids).toEqual(['a1', 'b1']);
  });

  test('skips threads in terminal stages', async () => {
    seedThread(testDb.db, {
      id: 'archived',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'done',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const svc = makeService();
    const summary = await svc.refresh();

    expect(summary.candidatesCount).toBe(0);
    expect(summary.dispatchedCount).toBe(0);
    expect(dispatcher.handles).toHaveLength(0);
  });

  test('does NOT redispatch a thread already claimed', async () => {
    seedThread(testDb.db, {
      id: 't1',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const svc = makeService();
    await svc.refresh();
    expect(dispatcher.handles).toHaveLength(1);

    await svc.refresh();
    expect(dispatcher.handles).toHaveLength(1); // still one — second tick saw the claim
  });

  test('schedules retry when the dispatcher reports a synchronous failure', async () => {
    seedThread(testDb.db, {
      id: 't1',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
    });
    let nowMs = 1_000_000;
    dispatcher.nextResult = { ok: false, error: { message: 'runner offline' } };

    const svc = makeService({}, () => nowMs);
    const summary = await svc.refresh();

    expect(summary.dispatchedCount).toBe(1); // planner dispatched
    const row = await runRepo.getRun('t1');
    expect(row?.attempt).toBe(1);
    expect(row?.lastError).toBe('runner offline');
    expect(row?.nextRetryAtMs).toBeGreaterThan(nowMs);

    const retryEvent = emitter.events.find((e) => e.type === 'thread:retry-queued');
    expect(retryEvent).toBeDefined();
    expect(retryEvent?.data.error).toBe('runner offline');
  });

  test('blocked-by-dependency threads stay queued until the blocker is terminal', async () => {
    seedThread(testDb.db, {
      id: 'gate',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
    });
    seedThread(testDb.db, {
      id: 'follow',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-02T00:00:00Z',
    });
    await runRepo.addDependency('follow', 'gate');

    // First tick: 'gate' is dispatchable, 'follow' is blocked.
    const svc = makeService();
    const first = await svc.refresh();
    expect(first.dispatchedCount).toBe(1);
    const firstIds = (await runRepo.listActiveRuns()).map((r) => r.threadId);
    expect(firstIds).toEqual(['gate']);

    // Move 'gate' to a terminal stage and release its run.
    testDb.sqlite.exec("UPDATE threads SET stage='done' WHERE id='gate'");
    await runRepo.release('gate');

    const second = await svc.refresh();
    expect(second.dispatchedCount).toBe(1);
    const secondIds = (await runRepo.listActiveRuns()).map((r) => r.threadId).sort();
    expect(secondIds).toEqual(['follow']);
  });

  test('start() is a no-op when feature flag is disabled', () => {
    const svc = new OrchestratorService({
      runRepo,
      threadQuery,
      dispatcher,
      emitter,
      config: { ...defaultOrchestratorConfig, enabled: false },
      log: silentLog,
    });
    svc.start();
    // No timers scheduled means no observable side effects; tick was
    // not invoked.
    expect(dispatcher.handles).toHaveLength(0);
  });
});

describe('OrchestratorService — completion handling', () => {
  test('releases the run when the dispatch finishes with completed', async () => {
    seedThread(testDb.db, {
      id: 't1',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const svc = makeService();
    await svc.refresh();
    expect(dispatcher.handles).toHaveLength(1);

    dispatcher.handles[0].resolve({ kind: 'completed' });
    // Allow the .then chain in onRunFinished to flush.
    await new Promise((r) => setTimeout(r, 5));

    expect(await runRepo.getRun('t1')).toBeUndefined();
    const released = emitter.events.find((e) => e.type === 'thread:released');
    expect(released?.data.terminalStatus).toBe('completed');
  });

  test('schedules retry when the dispatch finishes with failed', async () => {
    seedThread(testDb.db, {
      id: 't1',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
    });
    let nowMs = 2_000_000;
    const svc = makeService({}, () => nowMs);
    await svc.refresh();

    dispatcher.handles[0].resolve({ kind: 'failed', error: 'pipeline-crash' });
    await new Promise((r) => setTimeout(r, 5));

    const row = await runRepo.getRun('t1');
    expect(row?.attempt).toBe(1);
    expect(row?.lastError).toBe('pipeline-crash');
    expect(row?.nextRetryAtMs).toBeGreaterThan(nowMs);
  });
});

describe('OrchestratorService — stall detection', () => {
  test('aborts a stalled in-flight handle and emits thread:stalled', async () => {
    seedThread(testDb.db, {
      id: 't1',
      projectId: 'p1',
      userId: 'user-1',
      stage: 'in_progress',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
    });

    let nowMs = 1_000_000;
    const svc = makeService({ stallTimeoutMs: 5_000 }, () => nowMs);
    await svc.refresh();
    expect(dispatcher.handles).toHaveLength(1);

    // Skip past the stall window. The orchestrator_runs row was
    // populated with last_event_at_ms = original now.
    nowMs += 10_000;
    const summary = await svc.refresh();

    expect(summary.stalledCount).toBe(1);
    expect(dispatcher.handles[0].aborted).toBe(true);
    const stallEvent = emitter.events.find((e) => e.type === 'thread:stalled');
    expect(stallEvent?.data.threadId).toBe('t1');
  });
});
