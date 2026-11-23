import { describe, expect, test } from 'bun:test';

import type {
  FactoryReviewVerdict,
  FactoryRun,
  FactoryRunState,
  FactoryStepOptionsRecord,
} from '@funny/shared/contracts/factory';
import i18next from 'i18next';

import {
  DONE_WINDOW_MS,
  type FactoryBoardColumnId,
  factoryBoardColumn,
  layoutFactoryBoard,
} from '@/components/factory-board/board-columns';
import { factoryRunGateChips } from '@/components/factory-board/run-gates';
import { factoryRunStrip } from '@/components/factory-board/run-progress';
import { factoryRunWaitingText } from '@/components/factory-board/run-waiting';
import { buildFactoryRun } from '@/data/factory/testing';
import { filterFactoryRuns } from '@/lib/factory-run-labels';

/** An i18next with no resources: every text is its fallback, with its values filled in. */
const i18n = i18next.createInstance();
void i18n.init({ lng: 'en', resources: {}, initAsync: false });
const t = i18n.t.bind(i18n);

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();

describe('factoryBoardColumn', () => {
  const expected: Record<FactoryRunState, FactoryBoardColumnId> = {
    requested: 'queue',
    queued: 'queue',
    triaging: 'triage',
    working: 'implementing',
    fixing: 'implementing',
    pr_open: 'pr',
    waiting_ci: 'pr',
    reviewing: 'review',
    merging: 'merge',
    needs_info: 'needs_person',
    waiting_human: 'needs_person',
    failed: 'needs_person',
    no_change: 'needs_person',
    merged: 'done',
    stopped: 'done',
  };
  test('places every run state in one column', () => {
    for (const [state, column] of Object.entries(expected)) {
      expect(factoryBoardColumn(state)).toBe(column);
    }
  });
  test('a state this client does not know goes to a person', () => {
    expect(factoryBoardColumn('shiny_new_state')).toBe('needs_person');
  });
});

describe('layoutFactoryBoard', () => {
  test('keeps only the last day of finished runs and counts the rest', () => {
    const recent = buildFactoryRun({ id: 'recent', state: 'merged', completedAt: hoursAgo(2) });
    const old = buildFactoryRun({ id: 'old', state: 'merged', completedAt: hoursAgo(72) });
    const { columns, hiddenDone } = layoutFactoryBoard([recent, old], NOW);
    expect(columns.done.map((run) => run.id)).toEqual(['recent']);
    expect(hiddenDone).toBe(1);
    expect(DONE_WINDOW_MS).toBe(24 * 3600_000);
  });

  test('orders the queue by its order, admitted runs first; other columns newest first', () => {
    const run = (id: string, overrides: Partial<FactoryRun>) =>
      buildFactoryRun({ id, completedAt: null, ...overrides });
    const { columns } = layoutFactoryBoard(
      [
        run('second', { state: 'requested', queueOrder: 2, startedAt: hoursAgo(1) }),
        run('first', { state: 'requested', queueOrder: 1, startedAt: hoursAgo(5) }),
        run('admitted', { state: 'queued', admittedAt: hoursAgo(9) }),
        run('older', { state: 'working', admittedAt: hoursAgo(4) }),
        run('newer', { state: 'fixing', admittedAt: hoursAgo(1) }),
      ],
      NOW,
    );
    expect(columns.queue.map((r) => r.id)).toEqual(['admitted', 'first', 'second']);
    expect(columns.implementing.map((r) => r.id)).toEqual(['newer', 'older']);
  });
});

const review = (sha: string, verdict: 'pass' | 'fail'): FactoryReviewVerdict => ({
  sha,
  verdict,
  findings: verdict === 'fail' ? [{ severity: 'high', title: 'bug' }] : [],
  reviewedAt: hoursAgo(1),
});

const options = (stepId: string, model: string): FactoryStepOptionsRecord => ({
  stepId,
  threadId: `th-${model}`,
  provider: 'claude',
  model,
  effort: null,
  permissionMode: 'autoEdit',
  allowedTools: null,
  disallowedTools: null,
  thread: 'continue',
});

describe('factoryRunStrip', () => {
  const flowSteps = ['triage', 'implement', 'review', 'merge'];

  test('a second review round in progress', () => {
    const strip = factoryRunStrip(
      buildFactoryRun({
        state: 'reviewing',
        currentStep: 'review',
        flowSteps,
        reviews: [review('aaa', 'fail')],
      }),
    );
    expect(strip.map((s) => s.status)).toEqual(['done', 'done', 'current', 'pending']);
    expect(strip[2]?.round).toBe(2);
    expect(strip[1]?.round).toBeUndefined();
  });

  test('failed at the review step', () => {
    const strip = factoryRunStrip(
      buildFactoryRun({
        state: 'failed',
        currentStep: 'review',
        flowSteps,
        failureReason: 'boom',
        reviews: [review('aaa', 'fail')],
      }),
    );
    expect(strip[2]).toMatchObject({ status: 'failed', round: 1 });
  });

  test('a step that ran twice shows the options of its last run', () => {
    const strip = factoryRunStrip(
      buildFactoryRun({
        state: 'working',
        currentStep: 'implement',
        flowSteps,
        stepOptions: [options('implement', 'sonnet'), options('implement', 'opus')],
      }),
    );
    expect(strip[1]?.options?.model).toBe('opus');
    expect(strip[0]?.options).toBeUndefined();
  });

  test('no strip before the flow recorded its steps', () => {
    expect(factoryRunStrip(buildFactoryRun({ state: 'requested', flowSteps: [] }))).toEqual([]);
  });
});

describe('factoryRunGateChips', () => {
  test('no chips before any gate ran', () => {
    expect(factoryRunGateChips(t, buildFactoryRun({ state: 'working' }))).toEqual([]);
  });

  test('high risk lists its reasons', () => {
    const [risk] = factoryRunGateChips(
      t,
      buildFactoryRun({ risk: { headSha: 'h1', level: 'high', reasons: ['touches auth'] } }),
    );
    expect(risk).toMatchObject({ id: 'risk', tone: 'warn', detail: 'touches auth' });
  });

  test('a review of an older commit is stale', () => {
    const chips = factoryRunGateChips(
      t,
      buildFactoryRun({
        risk: { headSha: 'bbbbbbbbb', level: 'low', reasons: [] },
        reviews: [review('aaaaaaaaa', 'pass')],
      }),
    );
    expect(chips.find((c) => c.id === 'review')).toMatchObject({
      tone: 'pass',
      stale: true,
      detail: 'aaaaaaa',
    });
  });

  test('a proof carried to the head commit is current', () => {
    const chips = factoryRunGateChips(
      t,
      buildFactoryRun({
        risk: { headSha: 'head', level: 'low', reasons: [] },
        regressionProof: {
          headSha: 'head',
          carriedFrom: 'older',
          verdict: 'pass',
          ranAt: hoursAgo(1),
        },
      }),
    );
    expect(chips.find((c) => c.id === 'proof')).toMatchObject({ tone: 'pass', stale: false });
  });

  test('CI shows its rounds and what went wrong', () => {
    const run = buildFactoryRun({ state: 'reviewing' });
    run.metrics = { ...run.metrics, ciRounds: 3, ciRed: 1, conflicts: 1 };
    expect(factoryRunGateChips(t, run).find((c) => c.id === 'ci')).toMatchObject({
      tone: 'warn',
      label: 'CI ×3',
      detail: '1 red · 1 conflicts',
    });
  });
});

describe('factoryRunWaitingText', () => {
  test('a queued issue waits on shared paths', () => {
    expect(
      factoryRunWaitingText(
        t,
        buildFactoryRun({
          state: 'requested',
          waitReason: { kind: 'paths-overlap', blockers: [47] },
        }),
      ),
    ).toBe('Waiting for #47: it works on the same files');
  });

  test('triage asked two questions', () => {
    expect(
      factoryRunWaitingText(
        t,
        buildFactoryRun({
          state: 'needs_info',
          triage: { decision: 'needs_info', at: hoursAgo(1), items: ['a?', 'b?'] },
        }),
      ),
    ).toBe('Triage asked 2 questions on the issue');
  });

  test('failed and no-change runs', () => {
    expect(
      factoryRunWaitingText(t, buildFactoryRun({ state: 'failed', failureReason: 'disk full' })),
    ).toBe('disk full');
    expect(factoryRunWaitingText(t, buildFactoryRun({ state: 'no_change' }))).toContain(
      'Nothing to change',
    );
  });

  test('a parked run gives its recorded reason, or that it waits for a person', () => {
    const parked = (failureReason: string | null) =>
      factoryRunWaitingText(t, buildFactoryRun({ state: 'waiting_human', failureReason }));
    expect(parked('high risk')).toBe('Not merged: high risk, it needs you');
    expect(parked('no change')).toContain('unsaved work');
    expect(parked(null)).toBe('Waiting for a person');
  });

  test('a moving run has nothing to explain', () => {
    expect(factoryRunWaitingText(t, buildFactoryRun({ state: 'working' }))).toBeNull();
  });
});

describe('filterFactoryRuns activeOnly', () => {
  test('hides the runs nobody has to look at and keeps the order', () => {
    const runs = (
      ['merged', 'failed', 'no_change', 'working', 'stopped', 'waiting_human'] as const
    ).map((state) => ({ ...buildFactoryRun({ id: state, state }), projectId: 'p1' }));
    const kept = filterFactoryRuns(runs, {
      search: '',
      caseSensitive: false,
      states: new Set(),
      projectIds: new Set(),
      projectNameById: new Map(),
      activeOnly: true,
    });
    expect(kept.map((run) => run.id)).toEqual(['waiting_human', 'working', 'failed']);
  });
});
