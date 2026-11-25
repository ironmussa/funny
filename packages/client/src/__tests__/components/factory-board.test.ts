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
import { factoryRunGateChips, isFactoryRunHeldForRisk } from '@/components/factory-board/run-gates';
import { factoryRunStrip } from '@/components/factory-board/run-progress';
import {
  factoryBoardStateChip,
  factoryRunStateChip,
} from '@/components/factory-board/run-state-chip';
import { factoryRunWaitingText } from '@/components/factory-board/run-waiting';
import { buildFactoryRun } from '@/data/factory/testing';
import { factoryRunFallbackTitle, filterFactoryRuns } from '@/lib/factory-run-labels';

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
    done: 'done',
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

  // Issue #434: its run failed the regression proof, was stopped, and showed in
  // Done although nothing had fixed it.
  test('a run stopped after a failure waits for a person; a plain stop is done', () => {
    const { columns } = layoutFactoryBoard(
      [
        buildFactoryRun({
          id: 'failed-then-stopped',
          issueNumber: 434,
          state: 'stopped',
          failureReason: 'regression_proof[regression-proof] failed',
          completedAt: hoursAgo(1),
        }),
        buildFactoryRun({
          id: 'stopped',
          issueNumber: 435,
          state: 'stopped',
          failureReason: null,
          completedAt: hoursAgo(1),
        }),
      ],
      NOW,
    );
    expect(columns.needs_person.map((run) => run.id)).toEqual(['failed-then-stopped']);
    expect(columns.done.map((run) => run.id)).toEqual(['stopped']);
  });

  test('an ended run a newer run of its issue replaced is done', () => {
    const { columns } = layoutFactoryBoard(
      [
        buildFactoryRun({
          id: 'first',
          issueNumber: 434,
          state: 'stopped',
          failureReason: 'regression_proof[regression-proof] failed',
          startedAt: hoursAgo(8),
          completedAt: hoursAgo(7),
        }),
        buildFactoryRun({
          id: 'earlier-failure',
          issueNumber: 434,
          state: 'failed',
          failureReason: 'ci failed',
          startedAt: hoursAgo(10),
          completedAt: hoursAgo(9),
        }),
        buildFactoryRun({
          id: 'resent',
          issueNumber: 434,
          state: 'working',
          startedAt: hoursAgo(6),
          completedAt: null,
        }),
      ],
      NOW,
    );
    expect(columns.needs_person).toEqual([]);
    expect(columns.done.map((run) => run.id)).toEqual(['first', 'earlier-failure']);
    expect(columns.implementing.map((run) => run.id)).toEqual(['resent']);
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

  test('a review and proof that passed for the head commit have no chip', () => {
    const chips = factoryRunGateChips(
      t,
      buildFactoryRun({
        risk: { headSha: 'head', level: 'low', reasons: [] },
        reviews: [review('head', 'pass')],
        regressionProof: {
          headSha: 'head',
          carriedFrom: 'older',
          verdict: 'pass',
          ranAt: hoursAgo(1),
        },
      }),
    );
    expect(chips.map((c) => c.id)).toEqual(['risk']);
  });

  test('a failed review or proof keeps its chip', () => {
    const chips = factoryRunGateChips(
      t,
      buildFactoryRun({
        risk: { headSha: 'head', level: 'low', reasons: [] },
        reviews: [review('head', 'fail')],
        regressionProof: { headSha: 'head', verdict: 'fail', ranAt: hoursAgo(1) },
      }),
    );
    expect(chips.map((c) => [c.id, c.tone])).toEqual([
      ['risk', 'pass'],
      ['review', 'fail'],
      ['proof', 'fail'],
    ]);
  });

  test('a proof that passed for an older commit has no chip either', () => {
    const chips = factoryRunGateChips(
      t,
      buildFactoryRun({
        risk: { headSha: 'head', level: 'low', reasons: [] },
        regressionProof: { headSha: 'older', verdict: 'pass', ranAt: hoursAgo(1) },
      }),
    );
    expect(chips.map((c) => c.id)).toEqual(['risk']);
  });

  test('CI rounds that are over have no chip; running CI says which round', () => {
    const run = buildFactoryRun({ state: 'reviewing' });
    run.metrics = { ...run.metrics, ciRounds: 3, ciRed: 1, conflicts: 1 };
    expect(factoryRunGateChips(t, run).find((c) => c.id === 'ci')).toBeUndefined();
    expect(
      factoryRunGateChips(t, { ...run, state: 'waiting_ci' }).find((c) => c.id === 'ci'),
    ).toMatchObject({ label: 'CI running', detail: 'Round 4 · 1 red · 1 conflicts' });
  });

  test('a parked run without a commit gets a red No commit chip with the reason', () => {
    const run = buildFactoryRun({ state: 'waiting_human', failureReason: 'no change' });
    expect(factoryRunGateChips(t, run)).toEqual([
      expect.objectContaining({
        id: 'problem',
        tone: 'fail',
        label: 'No commit',
        detail: 'No commit, but unsaved work in its checkout',
      }),
    ]);
  });

  test('a step that failed names the step; a known merge hold gets its own label', () => {
    const failed = buildFactoryRun({
      state: 'waiting_human',
      failureReason: 'tests timed out',
      currentStep: 'implement',
    });
    expect(factoryRunGateChips(t, failed)[0]).toMatchObject({
      id: 'problem',
      label: 'implement failed',
      detail: 'tests timed out',
    });
    const noReview = buildFactoryRun({ state: 'waiting_human', failureReason: 'no review' });
    expect(factoryRunGateChips(t, noReview)[0]).toMatchObject({ label: 'No review' });
  });

  test('a risk hold or a failed review has no problem chip: its own chip says it', () => {
    for (const failureReason of ['high risk', 'review failed']) {
      const run = buildFactoryRun({ state: 'waiting_human', failureReason });
      expect(factoryRunGateChips(t, run).some((c) => c.id === 'problem')).toBe(false);
    }
  });

  test("a risk hold's reason moves to the High risk chip's tooltip", () => {
    const run = buildFactoryRun({
      state: 'waiting_human',
      failureReason: 'high risk',
      risk: { headSha: 'h1', level: 'high', reasons: ['touches auth'] },
    });
    expect(isFactoryRunHeldForRisk(run)).toBe(true);
    expect(factoryRunGateChips(t, run)[0]).toMatchObject({
      id: 'risk',
      detail: 'Not merged: high risk, it needs you\ntouches auth',
    });
  });
});

describe('board chips carry what the card used to say in lines', () => {
  test('a queued run waits behind an issue: a neutral chip, red when it cannot start', () => {
    const behind = buildFactoryRun({
      state: 'requested',
      waitReason: { kind: 'paths-overlap', blockers: [47, 48] },
    });
    expect(factoryRunGateChips(t, behind)[0]).toMatchObject({
      id: 'wait',
      tone: 'neutral',
      label: 'Same files as #47 +1',
      detail: 'Waiting for #47, #48: it works on the same files',
    });
    const blocked = buildFactoryRun({
      state: 'requested',
      waitReason: { kind: 'blocker-failed', blockers: [12] },
    });
    expect(factoryRunGateChips(t, blocked)[0]).toMatchObject({
      id: 'wait',
      tone: 'fail',
      label: 'Blocked by #12',
    });
  });

  test("triage's questions are the Needs info chip's tooltip", () => {
    const run = buildFactoryRun({
      state: 'needs_info',
      triage: { decision: 'needs_info', at: hoursAgo(1), items: ['a', 'b'] },
    });
    expect(factoryBoardStateChip(t, run, false)).toMatchObject({
      label: 'Needs info',
      detail: 'Triage asked 2 questions on the issue',
    });
  });

  test("a failed run's reason is the Failed chip's tooltip", () => {
    const run = buildFactoryRun({ state: 'failed', failureReason: 'tests timed out' });
    expect(factoryBoardStateChip(t, run, true)).toMatchObject({
      label: 'Failed',
      tone: 'danger',
      detail: 'tests timed out',
    });
  });
});

describe('factoryRunFallbackTitle', () => {
  test("a run with no thread is named by its issue's title once the run read it", () => {
    expect(
      factoryRunFallbackTitle(
        t,
        buildFactoryRun({ issueNumber: 490, issueTitle: 'Client stores' }),
      ),
    ).toBe('#490 Client stores');
    expect(
      factoryRunFallbackTitle(t, buildFactoryRun({ issueNumber: 490, issueTitle: null })),
    ).toBe('Issue #490');
  });
});

describe('factoryRunStateChip', () => {
  test('the states one column holds read apart', () => {
    expect(factoryRunStateChip(t, buildFactoryRun({ state: 'failed' }))).toEqual({
      label: 'Failed',
      tone: 'danger',
    });
    expect(factoryRunStateChip(t, buildFactoryRun({ state: 'waiting_human' })).tone).toBe(
      'warning',
    );
    expect(factoryRunStateChip(t, buildFactoryRun({ state: 'merged' }))).toEqual({
      label: 'Merged',
      tone: 'success',
    });
  });

  test('a too-large issue, and one the factory split', () => {
    const triage = { decision: 'too_big' as const, at: hoursAgo(1), items: ['a', 'b'] };
    expect(factoryRunStateChip(t, buildFactoryRun({ state: 'needs_info', triage })).label).toBe(
      'Too big',
    );
    expect(
      factoryRunStateChip(
        t,
        buildFactoryRun({ state: 'done', triage: { ...triage, splitInto: [40, 41] } }),
      ),
    ).toEqual({ label: 'Split', tone: 'info' });
  });
});

describe('factoryBoardStateChip', () => {
  test('a thread card leaves out the states its icon and column already show', () => {
    for (const state of ['working', 'waiting_human', 'stopped'] as const) {
      expect(factoryBoardStateChip(t, buildFactoryRun({ state }), true)).toBeNull();
    }
    expect(factoryBoardStateChip(t, buildFactoryRun({ state: 'failed' }), true)?.label).toBe(
      'Failed',
    );
    expect(factoryBoardStateChip(t, buildFactoryRun({ state: 'fixing' }), true)?.label).toBe(
      'Fixing CI',
    );
  });

  test('a card with no thread has a clock for its icon, so it keeps the chip', () => {
    const run = buildFactoryRun({ state: 'stopped', threadIds: ['t1'] });
    expect(factoryBoardStateChip(t, run, false)?.label).toBe('Stopped');
  });

  test('a run stopped before any agent ran says it never started, and how', () => {
    const queued = buildFactoryRun({ state: 'stopped', threadIds: [], admittedAt: null });
    expect(factoryBoardStateChip(t, queued, false)).toMatchObject({
      label: 'Not started',
      detail: expect.stringContaining('Taken out of the queue'),
    });
    const admitted = buildFactoryRun({
      state: 'stopped',
      threadIds: [],
      admittedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(factoryBoardStateChip(t, admitted, false)?.detail).toContain('before its first step');
  });

  test('waiting for you is the column itself, with or without a thread', () => {
    expect(factoryBoardStateChip(t, buildFactoryRun({ state: 'waiting_human' }), false)).toBeNull();
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

  test('a proposed split, and an issue the factory split', () => {
    expect(
      factoryRunWaitingText(
        t,
        buildFactoryRun({
          state: 'needs_info',
          triage: { decision: 'too_big', at: hoursAgo(1), items: ['Schema', 'Screen', 'Docs'] },
        }),
      ),
    ).toBe('Triage proposed a split into 3 parts');
    expect(
      factoryRunWaitingText(
        t,
        buildFactoryRun({
          state: 'done',
          triage: { decision: 'too_big', at: hoursAgo(1), items: ['a', 'b'], splitInto: [40, 41] },
        }),
      ),
    ).toBe('Split into #40, #41');
    expect(factoryRunWaitingText(t, buildFactoryRun({ state: 'done' }))).toBeNull();
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
