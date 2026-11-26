/**
 * The factory view's board layout (openspec factory-pipeline-board): runs in
 * stage columns, stage limits for one project, read-only cards, the layout
 * toggle and the Active filter.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import type { Thread } from '@funny/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { TooltipProvider } from '@/components/ui/tooltip';
import { buildFactoryRun } from '@/data/factory/testing';
import { buildThread } from '@/data/threads/testing';
import type { FactoryQueueRun, FactoryRun, FactorySettings } from '@/lib/api/factory';

const mocks = ((): {
  queue: FactoryQueueRun[];
  threads: Record<string, Thread>;
  settings: Partial<FactorySettings> | null;
  requests: Record<string, { id: string; sha: string }>;
  navigate: ReturnType<typeof vi.fn>;
  control: ReturnType<typeof vi.fn>;
  markDone: ReturnType<typeof vi.fn>;
} => ({
  queue: [],
  threads: {},
  settings: null,
  requests: {},
  navigate: vi.fn(),
  control: vi.fn(),
  markDone: vi.fn(),
}))();

mock.module('@/data/factory/hooks', () => ({
  useFactoryQueueRuns: () => mocks.queue,
  useFactorySettings: () => mocks.settings,
  // Only asked for a run that waits for an approval.
  usePendingApprovalRequestOfRun: (_projectId: string, runId: string, enabled: boolean) =>
    enabled ? (mocks.requests[runId] ?? null) : null,
}));
mock.module('@/lib/thread-selectors', () => ({
  useThreadById: (id: string | undefined) => (id ? mocks.threads[id] : undefined),
}));
mock.module('@/data/projects/hooks', () => ({
  useCanSteerProject: () => true,
  useProjects: () => [
    { id: 'p1', name: 'funny' },
    { id: 'p2', name: 'other' },
  ],
}));
mock.module('@/data/factory/actions', () => ({
  approveFactoryMerge: () => okAsync(null),
  setFactoryRunLintCleanup: () => ({ orTee: () => undefined }),
  markFactoryRunDone: (...args: unknown[]) => {
    mocks.markDone(...args);
    return okAsync(null);
  },
  controlFactoryRun: (...args: unknown[]) => {
    mocks.control(...args);
    return okAsync(null);
  },
  emptyFactory: () => okAsync({ cleared: 0, stopped: 0 }),
}));
mock.module('@/hooks/use-stable-navigate', () => ({ useStableNavigate: () => mocks.navigate }));
mock.module('@/hooks/use-minute-tick', () => ({ useMinuteTick: () => Date.now() }));
mock.module('@/lib/toast-error', () => ({ toastError: vi.fn() }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallback?: string | Record<string, unknown>,
      vars?: Record<string, unknown>,
    ) => {
      const text = typeof fallback === 'string' ? fallback : key;
      const values = typeof fallback === 'string' ? vars : fallback;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(values?.[name] ?? ''));
    },
  }),
}));

import {
  FACTORY_BOARD_COLUMNS,
  type FactoryBoardColumnId,
} from '@/components/factory-board/board-columns';
import { FactoryBoard } from '@/components/factory-board/FactoryBoard';
import { factoryRunDependencies } from '@/components/factory-board/run-dependencies';
import { FactoryQueueView } from '@/components/FactoryQueueView';
import { useFactoryViewStore } from '@/stores/factory-view-store';

const recent = () => new Date(Date.now() - 3600_000).toISOString();
const implementStep = (threadId: string) => ({
  stepId: 'implement',
  threadId,
  provider: 'claude',
  model: 'opus',
  effort: null,
  permissionMode: 'autoEdit',
  allowedTools: null,
  disallowedTools: null,
  thread: 'continue' as const,
});

const queueRun = (id: string, state: FactoryRun['state'], over: Partial<FactoryQueueRun> = {}) => ({
  ...buildFactoryRun({ id, state, completedAt: null, admittedAt: recent() }),
  projectId: 'p1',
  ...over,
});

const renderBoard = (runs: FactoryQueueRun[], singleProjectId: string | null = null) =>
  render(
    <MemoryRouter>
      <TooltipProvider>
        <FactoryBoard
          runs={runs}
          projectNameById={new Map([['p1', 'funny']])}
          now={Date.now()}
          singleProjectId={singleProjectId}
          onSelect={mocks.navigate}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  mocks.queue = [];
  mocks.threads = {};
  mocks.settings = null;
  mocks.navigate = vi.fn();
  mocks.control = vi.fn();
  useFactoryViewStore.setState({ layout: 'list' });
  localStorage.clear();
});

describe('FactoryBoard', () => {
  test('places each run in its stage column', () => {
    renderBoard([
      queueRun('r1', 'reviewing'),
      queueRun('r2', 'waiting_ci'),
      queueRun('r3', 'failed'),
    ]);
    const inColumn = (column: string, id: string) =>
      within(screen.getByTestId(`factory-board-column-${column}`)).queryByTestId(
        `factory-board-card-${id}`,
      );
    expect(inColumn('review', 'r1')).not.toBeNull();
    expect(inColumn('pr', 'r2')).not.toBeNull();
    expect(inColumn('needs_person', 'r3')).not.toBeNull();
    expect(inColumn('review', 'r2')).toBeNull();
  });

  test('shows the factory limits only when one project is shown', () => {
    mocks.settings = { maxConcurrent: 20, stageLimits: { review: 5 } };
    const runs = [queueRun('a', 'working'), queueRun('b', 'fixing'), queueRun('c', 'reviewing')];
    const { unmount } = renderBoard(runs, 'p1');
    expect(screen.getByTestId('factory-board-limit-implementing').textContent).toBe('2/20');
    expect(screen.getByTestId('factory-board-limit-review').textContent).toBe('1/5');
    expect(screen.getByTestId('factory-board-limit-merge')).toBeTruthy();
    unmount();
    renderBoard(runs, null);
    expect(screen.queryByTestId('factory-board-limit-implementing')).toBeNull();
  });

  test('a run stuck behind a blocker says which one and why, and the blocker lists what it holds', () => {
    const blocker = queueRun('r434', 'waiting_human', {
      issueNumber: 434,
      failureReason: 'integrate[integrate] failed: Could not commit the merge: \u001b[38;2;5m╭─╮',
    });
    const runs = [
      blocker,
      queueRun('r435', 'requested', {
        issueNumber: 435,
        waitReason: { kind: 'blocker-waiting-merge', blockers: [434] },
      }),
      queueRun('r436', 'requested', {
        issueNumber: 436,
        waitReason: { kind: 'blocker-in-progress', blockers: [435] },
      }),
    ];
    render(
      <TooltipProvider>
        <FactoryBoard
          runs={runs}
          projectNameById={new Map([['p1', 'funny']])}
          now={Date.now()}
          singleProjectId={null}
          onSelect={mocks.navigate}
          dependencies={factoryRunDependencies(runs)}
        />
      </TooltipProvider>,
    );
    const behind = screen.getByTestId('factory-board-deps-r435-stuck-behind');
    expect(behind.textContent).toBe(
      'Stuck behind #434: integrate[integrate] failed: Could not commit the merge:',
    );
    expect(behind.className).toContain('text-status-warning');
    expect(screen.getByTestId('factory-board-deps-r434-blocks').textContent).toBe(
      'Blocks #435 · then #436',
    );
    // What a run holds up reads last on its card: under the project line, as a
    // row of the card itself, so the card's own gap spaces it like every other row.
    const card = screen.getByTestId('factory-board-card-r434');
    const note = screen.getByTestId('factory-board-deps-r434');
    expect(note.parentElement).toBe(card);
    expect(card.lastElementChild).toBe(note);
    expect(note.previousElementSibling).toBe(screen.getByTestId('factory-board-card-r434-footer'));
    // The parked blocker's reason is its red problem chip, not a line of its own.
    expect(screen.queryByTestId('factory-board-waiting-r434')).toBeNull();
    const problem = screen.getByTestId('factory-board-gate-r434-problem');
    expect(problem.textContent).toBe('Integrate failed');
    expect(problem.dataset.tone).toBe('fail');
    // #436 waits on #435, which is only queued: no "stuck" line for it.
    expect(screen.queryByTestId('factory-board-deps-r436-stuck-behind')).toBeNull();
    fireEvent.click(screen.getByTestId('factory-board-deps-r435-issue-434'));
    expect(mocks.navigate).toHaveBeenCalledWith(blocker);
  });

  test("a run's pull request shows as the sidebar's PR chip: state icon and number", () => {
    renderBoard([
      queueRun('r1', 'reviewing', { prUrl: 'https://github.com/o/r/pull/443' }),
      queueRun('r2', 'merged', { prUrl: 'https://github.com/o/r/pull/440' }),
    ]);
    const open = screen.getByTestId('factory-board-pr-r1');
    expect(open.textContent).toBe('#443');
    expect(open.getAttribute('href')).toBe('https://github.com/o/r/pull/443');
    expect(screen.getByTestId('factory-board-pr-r1-icon-OPEN')).toBeTruthy();
    expect(screen.getByTestId('factory-board-pr-r2-icon-MERGED')).toBeTruthy();
  });

  test('a card shows no step strip: the column says the step', () => {
    renderBoard([
      queueRun('r1', 'working', {
        flowSteps: ['triage', 'implement', 'review'],
        currentStep: 'implement',
      }),
    ]);
    expect(screen.getByTestId('factory-board-card-r1')).toBeTruthy();
    expect(screen.queryByTestId('factory-board-progress-r1')).toBeNull();
  });

  test('a held run an agent asked about says so, for the held commit only', () => {
    const held = (id: string, headSha: string) =>
      queueRun(id, 'waiting_human', {
        failureReason: 'high risk',
        risk: { headSha, level: 'high', reasons: ['big'], changedLines: 900, paths: [] },
      });
    mocks.requests = {
      asked: { id: 'q1', sha: 'a'.repeat(40) },
      // The pull request moved on after the agent asked.
      moved: { id: 'q2', sha: 'a'.repeat(40) },
    };
    renderBoard([
      held('asked', 'a'.repeat(40)),
      held('moved', 'b'.repeat(40)),
      held('quiet', 'c'.repeat(40)),
    ]);
    expect(screen.getByTestId('factory-board-agent-asked-asked').textContent).toBe(
      'Approval asked',
    );
    expect(screen.queryByTestId('factory-board-agent-asked-moved')).toBeNull();
    expect(screen.queryByTestId('factory-board-agent-asked-quiet')).toBeNull();
    mocks.requests = {};
  });

  test("a run with a thread is the thread's kanban card: the PR, its threads in its menu, and the run's chips", async () => {
    mocks.threads['t-impl'] = buildThread({ id: 't-impl', title: '[Factory] #434 Thread recap' });
    const run = queueRun('r1', 'waiting_human', {
      threadIds: ['t-impl'],
      stepOptions: [implementStep('t-impl')],
      prUrl: 'https://github.com/o/r/pull/443',
      failureReason: 'review failed',
    });
    renderBoard([run]);
    const card = screen.getByTestId('factory-board-card-r1');
    expect(card.textContent).toContain('[Factory] #434 Thread recap');
    // Each of the run's threads has its own worktree, so no powerline: the
    // card's menu links its threads, and the footer holds the PR.
    const footer = within(card).getByTestId('factory-board-card-r1-footer');
    expect(within(card).queryByTestId('factory-board-thread-link-t-impl')).toBeNull();
    expect(within(footer).queryByTestId('kanban-card-powerline-t-impl')).toBeNull();
    expect(within(footer).getByTestId('kanban-card-pr-t-impl').textContent).toBe('#443');
    expect(within(card).queryByTestId('factory-board-issue-r1')).toBeNull();
    expect(screen.queryByTestId('factory-board-pr-r1')).toBeNull();
    expect(within(card).getByTestId('kanban-card-more-t-impl')).toBeTruthy();
    expect(card.getAttribute('draggable')).toBe('false');
    // The run's actions live in the card's own three-dot menu, not as buttons on the card.
    expect(screen.queryByTestId('factory-board-retry-r1')).toBeNull();
    fireEvent.click(card);
    expect(mocks.navigate).toHaveBeenCalledWith(run);
    fireEvent.pointerDown(within(card).getByTestId('kanban-card-more-t-impl'));
    const threadLink = await screen.findByTestId('factory-board-thread-link-t-impl');
    // The run's threads sit at the bottom of the menu, after its actions.
    const retry = await screen.findByTestId('factory-board-retry-r1');
    expect(
      retry.compareDocumentPosition(threadLink) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(retry);
    expect(mocks.control).toHaveBeenCalledWith('retry', 'p1', 'r1');
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });

  test("a thread in the card's menu opens its thread, not the run panel", async () => {
    mocks.threads['t-impl'] = buildThread({ id: 't-impl', title: '[Factory] #434 Thread recap' });
    const run = queueRun('r1', 'working', {
      threadIds: ['t-impl'],
      stepOptions: [implementStep('t-impl')],
    });
    renderBoard([run]);
    fireEvent.pointerDown(screen.getByTestId('kanban-card-more-t-impl'));
    fireEvent.click(await screen.findByTestId('factory-board-thread-link-t-impl'));
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(String(mocks.navigate.mock.calls[0]?.[0])).toContain('/threads/t-impl');
  });

  // A run triage handed to a person has no implementer, so its card had no way
  // to the thread whose answer the person must judge.
  test('a run waiting on a person links its last thread on the card, without opening the run panel', () => {
    const run = queueRun('r1', 'needs_info', {
      triage: { decision: 'needs_info', at: recent(), threadId: 't-triage', items: ['Which?'] },
    });
    renderBoard([run]);
    const link = screen.getByTestId('factory-board-last-thread-r1');
    expect(link.textContent).toBe('Triage');
    fireEvent.click(link);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(String(mocks.navigate.mock.calls[0]?.[0])).toContain('/threads/t-triage');
  });

  test('the card links the latest thread the run started: the reviewer after the implementer', () => {
    mocks.threads['t-impl'] = buildThread({ id: 't-impl', title: '[Factory] #434 Thread recap' });
    const run = queueRun('r1', 'reviewing', {
      threadIds: ['t-impl'],
      stepOptions: [implementStep('t-impl')],
      roleThreads: [{ role: 'review', threadId: 't-rev', startedAt: recent() }],
    });
    renderBoard([run]);
    expect(screen.getByTestId('factory-board-last-thread-r1').textContent).toBe('Reviewer');
  });

  test('a queued run with no thread links none', () => {
    renderBoard([queueRun('r1', 'requested')]);
    expect(screen.queryByTestId('factory-board-last-thread-r1')).toBeNull();
  });

  test('cards cannot be dragged, and opening one selects the run', () => {
    const run = queueRun('r1', 'working', { threadIds: ['t-impl'] });
    renderBoard([run]);
    expect(screen.getByTestId('factory-board-card-r1').getAttribute('draggable')).toBe('false');
    fireEvent.click(screen.getByTestId('factory-board-open-r1'));
    expect(mocks.navigate).toHaveBeenCalledWith(run);
  });

  test('like a kanban card, the whole card opens the run, but its menu and links do not', async () => {
    const run = queueRun('r1', 'waiting_human', {
      failureReason: 'review failed',
      prUrl: 'https://github.com/o/r/pull/9',
    });
    renderBoard([run]);
    fireEvent.click(screen.getByTestId('factory-board-card-r1'));
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId('factory-board-card-r1'), { key: 'Enter' });
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(screen.getByTestId('factory-board-more-r1'));
    fireEvent.click(await screen.findByTestId('factory-board-retry-r1'));
    expect(mocks.control).toHaveBeenCalledWith('retry', 'p1', 'r1');
    fireEvent.click(screen.getByTestId('factory-board-pr-r1'));
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
  });

  test('a run without an issue shows its schedule in place of the issue number, and no issue link', () => {
    renderBoard([
      queueRun('sched', 'working', {
        issueNumber: null,
        source: 'schedule',
        triggerName: 'Nightly audit',
        flowName: 'audit',
        prUrl: 'https://github.com/o/r/pull/9',
      }),
      queueRun('once', 'working', { issueNumber: null, source: 'run_now', flowName: 'audit' }),
    ]);
    expect(screen.getByTestId('factory-board-open-sched').textContent).toBe(
      'Nightly audit · audit',
    );
    // No separate issue or schedule line: the title names it.
    expect(screen.queryByTestId('factory-board-issue-sched')).toBeNull();
    expect(screen.queryByTestId('factory-board-ref-sched')).toBeNull();
  });

  // The agent found nothing to change: the member agrees from the card's menu.
  test('a run that ended with no change offers "Mark as done" next to Retry', async () => {
    renderBoard([queueRun('r1', 'no_change', { completedAt: recent() })]);
    const card = screen.getByTestId('factory-board-card-r1');
    fireEvent.pointerDown(within(card).getByTestId('factory-board-more-r1'));
    expect(await screen.findByTestId('factory-board-retry-r1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('factory-board-mark-done-r1'));
    expect(mocks.markDone).toHaveBeenCalledWith('p1', 'r1');
    expect(mocks.control).not.toHaveBeenCalled();
  });

  // #532: its issue was closed as a duplicate; nothing else takes the run out of "Needs a person".
  test('a stopped run offers "Mark as done"', async () => {
    renderBoard([queueRun('r1', 'stopped', { completedAt: recent(), threadIds: ['t1'] })]);
    const card = screen.getByTestId('factory-board-card-r1');
    fireEvent.pointerDown(within(card).getByTestId('factory-board-more-r1'));
    fireEvent.click(await screen.findByTestId('factory-board-mark-done-r1'));
    expect(mocks.markDone).toHaveBeenCalledWith('p1', 'r1');
  });

  test('a run that failed offers no "Mark as done"', async () => {
    renderBoard([queueRun('r1', 'failed', { completedAt: recent() })]);
    const card = screen.getByTestId('factory-board-card-r1');
    fireEvent.pointerDown(within(card).getByTestId('factory-board-more-r1'));
    expect(await screen.findByTestId('factory-board-retry-r1')).toBeTruthy();
    expect(screen.queryByTestId('factory-board-mark-done-r1')).toBeNull();
  });

  test('a run that ended done is in the Done column', () => {
    renderBoard([
      queueRun('fin', 'done', { issueNumber: null, triggerName: 'Nightly', completedAt: recent() }),
    ]);
    expect(
      within(screen.getByTestId('factory-board-column-done')).queryByTestId(
        'factory-board-card-fin',
      ),
    ).not.toBeNull();
  });

  test('old finished runs stay in Done, after the recent ones', () => {
    renderBoard([
      queueRun('old', 'merged', { completedAt: '2020-01-01T00:00:00.000Z' }),
      queueRun('new', 'merged', { completedAt: recent() }),
    ]);
    const done = screen.getByTestId('factory-board-column-done');
    const cards = within(done)
      .getAllByTestId(/^factory-board-card-(new|old)$/)
      .map((card) => card.dataset.testid);
    expect(cards).toEqual(['factory-board-card-new', 'factory-board-card-old']);
    expect(screen.queryByTestId('factory-board-done-hidden')).toBeNull();
  });

  // One state per column: every column pages its cards in as it scrolls, none has a button.
  const STATE_OF_COLUMN: Record<FactoryBoardColumnId, FactoryRun['state']> = {
    queue: 'requested',
    triage: 'triaging',
    implementing: 'working',
    pr: 'pr_open',
    review: 'reviewing',
    merge: 'merging',
    needs_person: 'waiting_human',
    waiting_parts: 'done',
    done: 'merged',
  };
  // A done run whose work an issue the board does not list still tracks.
  const trackedTriage = {
    decision: 'too_big' as const,
    at: new Date().toISOString(),
    items: [],
    existing: [9999],
  };
  const longColumn = (column: FactoryBoardColumnId) =>
    Array.from({ length: 60 }, (_, i) =>
      queueRun(`${column}-${i}`, STATE_OF_COLUMN[column], {
        issueNumber: 1000 + i,
        queueOrder: i,
        completedAt: column === 'done' ? new Date(Date.now() - i * 60_000).toISOString() : null,
        triage: column === 'waiting_parts' ? trackedTriage : null,
      }),
    );
  const cardsIn = (column: FactoryBoardColumnId) =>
    within(screen.getByTestId(`factory-board-column-${column}`)).queryAllByTestId(
      new RegExp(`^factory-board-card-${column}-\\d+$`),
    );

  /** Sees its target in view as soon as it observes it: the end of the list was reached. */
  class InViewObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly scrollMargin = '';
    readonly thresholds: readonly number[] = [];
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      const entry: Partial<IntersectionObserverEntry> = { isIntersecting: true, target };
      this.callback([entry as IntersectionObserverEntry], this);
    }
    disconnect() {}
    unobserve() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  for (const column of FACTORY_BOARD_COLUMNS) {
    test(`the ${column} column shows a page, then loads the rest as it scrolls`, () => {
      // Without an IntersectionObserver the sentinel never fires: the first page only.
      renderBoard(longColumn(column));
      expect(cardsIn(column)).toHaveLength(50);
      const columnEl = screen.getByTestId(`factory-board-column-${column}`);
      expect(within(columnEl).getByTestId(`factory-board-more-${column}`)).toBeTruthy();
      expect(within(columnEl).queryByRole('button', { name: /show .* more/i })).toBeNull();
    });

    test(`scrolling to the end of the ${column} column loads its next page`, () => {
      const original = globalThis.IntersectionObserver;
      globalThis.IntersectionObserver = InViewObserver;
      try {
        renderBoard(longColumn(column));
        expect(cardsIn(column)).toHaveLength(60);
        expect(screen.queryByTestId(`factory-board-more-${column}`)).toBeNull();
      } finally {
        globalThis.IntersectionObserver = original;
      }
    });
  }
});

describe('state dot and selection', () => {
  test('a run waiting on a person shows a state dot, not a clock or the thread pin; a finished run shows none', () => {
    mocks.threads = { t1: buildThread({ id: 't1', projectId: 'p1', status: 'completed' }) };
    renderBoard([
      queueRun('stopped', 'stopped', { threadIds: [] }),
      queueRun('merged', 'merged', { threadIds: ['t1'], completedAt: recent() }),
      queueRun('waiting', 'waiting_human', { threadIds: ['t1'] }),
    ]);
    // Done's chip (Stopped, Merged) already says how the run ended.
    expect(screen.queryByTestId('factory-board-dot-stopped')).toBeNull();
    expect(screen.queryByTestId('factory-board-dot-merged')).toBeNull();
    expect(screen.getByTestId('factory-board-dot-waiting').getAttribute('data-state')).toBe(
      'waiting_human',
    );
  });

  test('picking runs offers retry to the retryable ones and stop to the unfinished ones', () => {
    mocks.queue = [
      queueRun('broken', 'failed'),
      queueRun('busy', 'working'),
      queueRun('merged', 'merged', { completedAt: recent() }),
    ];
    render(
      <MemoryRouter initialEntries={['/factory?view=board']}>
        <TooltipProvider>
          <FactoryQueueView />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('factory-bulk-actions')).toBeNull();
    // A finished run has no dot, so it keeps no blank slot before its title:
    // only the hover checkbox, until a run is picked.
    const mergedBox = () => screen.getByTestId('factory-board-select-merged');
    expect(mergedBox().closest('[data-collapsed]')).toBeTruthy();
    expect(
      screen.getByTestId('factory-board-select-broken').closest('[data-collapsed]'),
    ).toBeNull();
    for (const id of ['broken', 'busy', 'merged']) {
      fireEvent.click(screen.getByTestId(`factory-board-select-${id}`));
    }
    // Picking a run does not open it.
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('factory-bulk-count')).toHaveTextContent('3 selected');
    expect(screen.getByTestId('factory-bulk-retry')).toHaveTextContent('Retry (1)');
    expect(screen.getByTestId('factory-bulk-stop')).toHaveTextContent('Stop (1)');

    fireEvent.click(screen.getByTestId('factory-bulk-retry'));
    expect(mocks.control.mock.calls).toEqual([['retry', 'p1', 'broken']]);
    // The selection clears once the action is sent.
    expect(screen.queryByTestId('factory-bulk-actions')).toBeNull();

    fireEvent.click(screen.getByTestId('factory-board-select-busy'));
    fireEvent.click(screen.getByTestId('factory-bulk-stop'));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(mocks.control.mock.calls.at(-1)).toEqual(['stop', 'p1', 'busy']);
  });
});

describe('time on the board', () => {
  const minAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  const timing = (step: string, start: number, end: number | null) => ({
    step,
    visit: '1',
    attempt: 1,
    status: end === null ? ('running' as const) : ('succeeded' as const),
    startedAt: minAgo(start),
    finishedAt: end === null ? null : minAgo(end),
  });

  test('a card says on its footer line how long the run has been in its step, or waiting for it', () => {
    renderBoard([
      queueRun('rev', 'reviewing', {
        currentStep: 'review',
        stepTimings: [timing('review', 120, null)],
      }),
      queueRun('mrg', 'merging', { currentStep: 'merge', stepTimings: [timing('review', 60, 20)] }),
      queueRun('none', 'working', { currentStep: 'implement' }),
    ]);
    expect(screen.getByTestId('factory-board-time-rev')).toHaveTextContent('In review 2h');
    expect(screen.getByTestId('factory-board-time-mrg')).toHaveTextContent('Waiting for merge 20m');
    // It takes the footer's time slot, not a line of its own under the chips.
    expect(
      within(screen.getByTestId('factory-board-card-rev-footer')).getByTestId(
        'factory-board-time-rev',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('factory-board-time-none')).toBeNull();
  });

  test('a column header shows the median time in its stage, none without timings', () => {
    renderBoard([
      queueRun('a', 'merged', { completedAt: minAgo(1), stepTimings: [timing('review', 20, 10)] }),
      queueRun('b', 'merged', { completedAt: minAgo(1), stepTimings: [timing('review', 70, 30)] }),
      queueRun('c', 'merged', { completedAt: minAgo(1), stepTimings: [timing('review', 200, 80)] }),
    ]);
    expect(screen.getByTestId('factory-board-median-review')).toHaveTextContent('40m');
    expect(screen.queryByTestId('factory-board-median-merge')).toBeNull();
  });
});

describe('FactoryQueueView layouts', () => {
  test('filters apply to the board, and the layout survives a remount', () => {
    mocks.queue = [
      queueRun('busy', 'working'),
      queueRun('merged', 'merged', { completedAt: recent() }),
    ];
    const { unmount } = render(
      <MemoryRouter>
        <TooltipProvider>
          <FactoryQueueView />
        </TooltipProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('factory-view-layout-board'));
    expect(screen.getByTestId('factory-board')).toBeTruthy();
    expect(screen.getByTestId('factory-board-card-merged')).toBeTruthy();
    fireEvent.click(screen.getByTestId('factory-view-show-active'));
    expect(screen.queryByTestId('factory-board-card-merged')).toBeNull();
    expect(screen.getByTestId('factory-board-card-busy')).toBeTruthy();
    unmount();

    render(
      <MemoryRouter>
        <TooltipProvider>
          <FactoryQueueView />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('factory-board')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('funny:factory-view-layout') ?? '{}').state.layout).toBe(
      'board',
    );
  });

  test('the analytics layout shows the figures, the filters only change the integration ones', () => {
    mocks.queue = [
      queueRun('busy', 'working', { startedAt: recent() }),
      queueRun('other', 'merged', { projectId: 'p2', startedAt: recent(), completedAt: recent() }),
    ];
    render(
      <MemoryRouter initialEntries={['/factory?project=p1']}>
        <TooltipProvider>
          <FactoryQueueView />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('factory-view-health')).toBeNull();
    fireEvent.click(screen.getByTestId('factory-view-layout-analytics'));
    expect(screen.getByTestId('factory-analytics')).toBeTruthy();
    expect(screen.queryByTestId('factory-view-list')).toBeNull();
    expect(screen.getByTestId('factory-view-health-in-flight')).toHaveTextContent('1');
    expect(screen.getByTestId('factory-view-health-merged-day')).toHaveTextContent('1');
    expect(screen.getByTestId('factory-metric-runs')).toHaveTextContent('1');
  });

  test('a link names the filters and the layout, and changing them updates the link', () => {
    mocks.queue = [
      queueRun('busy', 'working'),
      queueRun('broken', 'failed'),
      queueRun('other', 'failed', { projectId: 'p2' }),
    ];
    function LocationProbe() {
      return <output data-testid="location">{useLocation().search}</output>;
    }
    const search = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '');
    render(
      <MemoryRouter initialEntries={['/factory?project=p1&status=failed&view=board']}>
        <TooltipProvider>
          <FactoryQueueView />
          <LocationProbe />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('factory-board')).toBeTruthy();
    expect(screen.getByTestId('factory-board-card-broken')).toBeTruthy();
    expect(screen.queryByTestId('factory-board-card-busy')).toBeNull();
    expect(screen.queryByTestId('factory-board-card-other')).toBeNull();

    fireEvent.click(screen.getByTestId('factory-view-show-active'));
    expect(search().get('active')).toBe('1');
    fireEvent.click(screen.getByTestId('factory-view-clear-filters'));
    const params = search();
    expect(params.get('project')).toBeNull();
    expect(params.get('status')).toBeNull();
    expect(params.get('view')).toBe('board');
  });
});
