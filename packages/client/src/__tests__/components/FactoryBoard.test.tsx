/**
 * The factory view's board layout (openspec factory-pipeline-board): runs in
 * stage columns, stage limits for one project, read-only cards, the layout
 * toggle and the Active filter.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { MemoryRouter } from 'react-router-dom';

import { TooltipProvider } from '@/components/ui/tooltip';
import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryQueueRun, FactoryRun, FactorySettings } from '@/lib/api/factory';

const mocks = ((): {
  queue: FactoryQueueRun[];
  settings: Partial<FactorySettings> | null;
  navigate: ReturnType<typeof vi.fn>;
} => ({ queue: [], settings: null, navigate: vi.fn() }))();

mock.module('@/data/factory/hooks', () => ({
  useFactoryQueueRuns: () => mocks.queue,
  useFactorySettings: () => mocks.settings,
}));
mock.module('@/lib/thread-selectors', () => ({ useThreadById: () => undefined }));
mock.module('@/data/projects/hooks', () => ({
  useCanSteerProject: () => true,
  useProjects: () => [
    { id: 'p1', name: 'funny' },
    { id: 'p2', name: 'other' },
  ],
}));
mock.module('@/data/factory/actions', () => ({ controlFactoryRun: () => okAsync(null) }));
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

import { FactoryBoard } from '@/components/factory-board/FactoryBoard';
import { FactoryQueueView } from '@/components/FactoryQueueView';
import { useFactoryViewStore } from '@/stores/factory-view-store';

const recent = () => new Date(Date.now() - 3600_000).toISOString();
const queueRun = (id: string, state: FactoryRun['state'], over: Partial<FactoryQueueRun> = {}) => ({
  ...buildFactoryRun({ id, state, completedAt: null, admittedAt: recent() }),
  projectId: 'p1',
  ...over,
});

const renderBoard = (runs: FactoryQueueRun[], singleProjectId: string | null = null) =>
  render(
    <TooltipProvider>
      <FactoryBoard
        runs={runs}
        projectNameById={new Map([['p1', 'funny']])}
        now={Date.now()}
        singleProjectId={singleProjectId}
        onSelect={mocks.navigate}
        onShowOlderDone={vi.fn()}
      />
    </TooltipProvider>,
  );

beforeEach(() => {
  mocks.queue = [];
  mocks.settings = null;
  mocks.navigate = vi.fn();
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

  test('cards cannot be dragged, and opening one selects the run', () => {
    const run = queueRun('r1', 'working', { threadIds: ['t-impl'] });
    renderBoard([run]);
    expect(screen.getByTestId('factory-board-card-r1').getAttribute('draggable')).toBe('false');
    fireEvent.click(screen.getByTestId('factory-board-open-r1'));
    expect(mocks.navigate).toHaveBeenCalledWith(run);
  });

  test('old finished runs are left to the list and counted', () => {
    renderBoard([
      queueRun('new', 'merged', { completedAt: recent() }),
      queueRun('old', 'merged', { completedAt: '2020-01-01T00:00:00.000Z' }),
    ]);
    expect(screen.queryByTestId('factory-board-card-old')).toBeNull();
    expect(screen.getByTestId('factory-board-done-hidden').textContent).toContain('+1');
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
});
