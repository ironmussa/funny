import type { Thread } from '@funny/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { ThreadList } from '@/components/sidebar/ThreadList';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';
import { seedThreads } from '../helpers/seed-thread-state';

const mockNavigate = vi.fn();
const mockEnsureBranch = vi.fn().mockResolvedValue(true);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/hooks/use-stable-navigate', () => ({
  useStableNavigate: () => mockNavigate,
}));

vi.mock('@/hooks/use-branch-switch', () => ({
  useBranchSwitch: () => ({
    ensureBranch: mockEnsureBranch,
    branchSwitchDialog: null,
  }),
}));

vi.mock('@/hooks/use-minute-tick', () => ({
  useMinuteTick: () => {},
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: vi.fn(() => () => {}),
}));

function getVisibleThreadRows() {
  return screen.getAllByTestId(/^thread-item-/).filter((el) => {
    const testId = el.getAttribute('data-testid') ?? '';
    return !testId.includes('attachments') && !testId.includes('-more-');
  });
}

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: 'p1',
    title: `Thread ${id}`,
    status: 'completed',
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  } as Thread;
}

const noopHandlers = {
  onRenameThread: vi.fn(),
  onArchiveThread: vi.fn(),
  onDeleteThread: vi.fn(),
};

describe('ThreadList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'My Project', path: '/repo' } as any],
      expandedProjects: new Set(['p1']),
    });
    useThreadStore.setState({
      ...seedThreads({ p1: [] }),
      scratchThreadIds: [],
      selectedThreadId: null,
      activeThread: null,
    } as any);
  });

  test('shows empty state when no visible threads exist', () => {
    useThreadStore.setState({
      ...seedThreads({
        p1: [makeThread('idle-1', { status: 'idle' })],
      }),
      scratchThreadIds: [],
    } as any);

    renderWithProviders(<ThreadList {...noopHandlers} />);

    expect(screen.getByTestId('activity-no-threads')).toBeInTheDocument();
  });

  test('renders running and completed threads but hides idle ones', () => {
    useThreadStore.setState({
      ...seedThreads({
        p1: [
          makeThread('idle-1', { status: 'idle' }),
          makeThread('done-1', { status: 'completed', title: 'Done thread' }),
          makeThread('run-1', { status: 'running', title: 'Running thread' }),
        ],
      }),
      scratchThreadIds: [],
    } as any);

    renderWithProviders(<ThreadList {...noopHandlers} />);

    expect(screen.getByTestId('thread-item-run-1')).toBeInTheDocument();
    expect(screen.getByTestId('thread-item-done-1')).toBeInTheDocument();
    expect(screen.queryByTestId('thread-item-idle-1')).not.toBeInTheDocument();
  });

  test('prioritizes running threads and caps the list at five items', () => {
    const completed = Array.from({ length: 6 }, (_, i) =>
      makeThread(`done-${i}`, {
        status: 'completed',
        title: `Done ${i}`,
        completedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }),
    );

    useThreadStore.setState({
      ...seedThreads({
        p1: [...completed, makeThread('run-1', { status: 'running', title: 'Running' })],
      }),
      scratchThreadIds: [],
    } as any);

    renderWithProviders(<ThreadList {...noopHandlers} />);

    expect(screen.getByTestId('thread-item-run-1')).toBeInTheDocument();
    expect(getVisibleThreadRows()).toHaveLength(5);
    expect(screen.getByText('sidebar.viewAll')).toBeInTheDocument();
  });

  test('includes scratch threads in the activity list', () => {
    const scratch = makeThread('scratch-1', {
      isScratch: true,
      projectId: '',
      status: 'running',
      title: 'Scratch idea',
    });

    useThreadStore.setState({
      threadsById: { 'scratch-1': scratch },
      threadIdsByProject: {},
      scratchThreadIds: ['scratch-1'],
    } as any);

    renderWithProviders(<ThreadList {...noopHandlers} />);

    expect(screen.getByTestId('thread-item-scratch-1')).toBeInTheDocument();
    expect(screen.getByTestId('thread-scratch-badge-scratch-1')).toBeInTheDocument();
  });

  test('navigates to thread route on select', async () => {
    const thread = makeThread('t-nav', { status: 'running', branch: 'main', mode: 'local' });
    useThreadStore.setState({
      ...seedThreads({ p1: [thread] }),
      scratchThreadIds: [],
      selectedThreadId: null,
    } as any);

    renderWithProviders(<ThreadList {...noopHandlers} />);

    fireEvent.click(screen.getByTestId('thread-item-t-nav'));

    await waitFor(() => {
      expect(mockEnsureBranch).toHaveBeenCalledWith('p1', 'main');
      expect(mockNavigate).toHaveBeenCalledWith('/projects/p1/threads/t-nav');
    });
  });
});
