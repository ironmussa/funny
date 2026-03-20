import { screen } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { ThreadView } from '@/components/ThreadView';
import { useAppStore } from '@/stores/app-store';

import { renderWithProviders } from '../helpers/render';

// ── IntersectionObserver polyfill for jsdom ─────────────────────
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
});

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, any>) =>
      typeof fallbackOrOpts === 'string' ? fallbackOrOpts : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', async () => {
  const { okAsync } = await import('neverthrow');
  return {
    api: {
      sendMessage: vi.fn().mockReturnValue(okAsync({})),
      stopThread: vi.fn().mockReturnValue(okAsync({})),
      approveTool: vi.fn().mockReturnValue(okAsync({})),
      listBranches: vi
        .fn()
        .mockReturnValue(okAsync({ branches: [], defaultBranch: 'main', currentBranch: 'main' })),
      listWorktrees: vi.fn().mockReturnValue(okAsync([])),
      listSkills: vi.fn().mockReturnValue(okAsync({ skills: [] })),
      remoteUrl: vi.fn().mockReturnValue(okAsync({ url: '' })),
      browseFiles: vi.fn().mockReturnValue(okAsync({ entries: [] })),
    },
  };
});

vi.mock('@/components/ImageLightbox', () => ({
  ImageLightbox: () => null,
}));

vi.mock('@/components/thread/ProjectHeader', () => ({
  ProjectHeader: () => <div data-testid="project-header" />,
}));

vi.mock('@/components/thread/NewThreadInput', () => ({
  NewThreadInput: () => <div data-testid="new-thread-input" />,
}));

vi.mock('@/components/thread/AgentStatusCards', () => ({
  AgentResultCard: ({ status, cost }: any) => (
    <div data-testid="agent-result-card">
      {status} - ${cost}
    </div>
  ),
  AgentInterruptedCard: () => <div data-testid="agent-interrupted-card" />,
  AgentStoppedCard: () => <div data-testid="agent-stopped-card" />,
}));

vi.mock('@/hooks/use-minute-tick', () => ({
  useMinuteTick: () => {},
}));

vi.mock('@/hooks/use-todo-panel', () => ({
  useTodoSnapshots: () => [],
}));

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: Object.assign(() => ({}), { getState: () => ({ toolPermissions: {} }) }),
  deriveToolLists: () => ({ allowedTools: [], disallowedTools: [] }),
}));

vi.mock('@/components/thread/StickyUserMessage', () => ({
  StickyUserMessage: () => null,
}));

vi.mock('@/components/thread/TodoPanel', () => ({
  TodoPanel: () => null,
}));

vi.mock('@/components/ToolCallCard', () => ({
  ToolCallCard: ({ name }: any) => <div data-testid="tool-call-card">{name}</div>,
}));

vi.mock('@/components/ToolCallGroup', () => ({
  ToolCallGroup: ({ name }: any) => <div data-testid="tool-call-group">{name}</div>,
}));

vi.mock('@/components/PromptInput', () => ({
  PromptInput: () => <div data-testid="prompt-input" />,
}));

vi.mock('motion/react', () => {
  const filterMotionProps = (props: any) =>
    Object.fromEntries(
      Object.entries(props).filter(
        ([k]) => !['initial', 'animate', 'transition', 'exit', 'layout'].includes(k),
      ),
    );
  return {
    motion: {
      div: ({ children, ...props }: any) => <div {...filterMotionProps(props)}>{children}</div>,
      span: ({ children, ...props }: any) => <span {...filterMotionProps(props)}>{children}</span>,
    },
    AnimatePresence: ({ children }: any) => <>{children}</>,
    useReducedMotion: () => false,
  };
});

vi.mock('react-markdown', () => ({
  default: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('remark-gfm', () => ({
  default: [],
}));

// ── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  useAppStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'Test',
        path: '/tmp/test',
        userId: 'user-1',
        createdAt: '',
        sortOrder: 0,
      },
    ],
    selectedProjectId: 'p1',
    selectedThreadId: null,
    activeThread: null,
    newThreadProjectId: null,
  });
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('ThreadView', () => {
  test('shows empty state when no thread or project selected', () => {
    useAppStore.setState({ selectedProjectId: null });
    renderWithProviders(<ThreadView />);
    expect(screen.getByText('thread.selectOrCreate')).toBeInTheDocument();
  });

  test('shows new thread input when project is selected but no thread', () => {
    // With selectedProjectId set but no thread, shows NewThreadInput
    renderWithProviders(<ThreadView />);
    expect(screen.getByTestId('new-thread-input')).toBeInTheDocument();
  });

  test('shows new thread input when newThreadProjectId is set', () => {
    useAppStore.setState({ newThreadProjectId: 'p1' });
    renderWithProviders(<ThreadView />);
    expect(screen.getByTestId('new-thread-input')).toBeInTheDocument();
  });

  test('renders user and assistant messages from active thread', () => {
    useAppStore.setState({
      selectedThreadId: 't1',
      activeThread: {
        id: 't1',
        projectId: 'p1',
        title: 'Test Thread',
        status: 'completed',
        cost: 0,
        messages: [
          { id: 'm1', threadId: 't1', role: 'user', content: 'Hello agent', timestamp: '' },
          { id: 'm2', threadId: 't1', role: 'assistant', content: 'Hello human', timestamp: '' },
        ],
      } as any,
    });

    renderWithProviders(<ThreadView />);

    // The user message text may appear in multiple places (message + sticky header)
    expect(screen.getAllByText('Hello agent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Hello human').length).toBeGreaterThan(0);
  });

  test('shows tool call cards for messages with toolCalls', () => {
    useAppStore.setState({
      selectedThreadId: 't1',
      activeThread: {
        id: 't1',
        projectId: 'p1',
        title: 'Test Thread',
        status: 'completed',
        cost: 0,
        messages: [
          {
            id: 'm1',
            threadId: 't1',
            role: 'assistant',
            content: 'Let me read that file',
            timestamp: '',
            toolCalls: [
              { id: 'tc1', name: 'Read', input: '{"file":"test.ts"}', output: 'file contents' },
            ],
          },
        ],
      } as any,
    });

    renderWithProviders(<ThreadView />);

    // ToolCallCard mock renders the tool name
    expect(screen.getByText('Read')).toBeInTheDocument();
  });

  test('shows running indicator when status is running', () => {
    useAppStore.setState({
      selectedThreadId: 't1',
      activeThread: {
        id: 't1',
        projectId: 'p1',
        title: 'Test Thread',
        status: 'running',
        cost: 0,
        messages: [],
      } as any,
    });

    renderWithProviders(<ThreadView />);
    expect(screen.getByText('thread.agentWorking')).toBeInTheDocument();
  });

  test('shows result card when thread completed with resultInfo', () => {
    useAppStore.setState({
      selectedThreadId: 't1',
      activeThread: {
        id: 't1',
        projectId: 'p1',
        title: 'Test Thread',
        status: 'completed',
        cost: 0.05,
        messages: [],
        resultInfo: { status: 'completed', cost: 0.05, duration: 1200 },
      } as any,
    });

    renderWithProviders(<ThreadView />);
    expect(screen.getByTestId('agent-result-card')).toBeInTheDocument();
  });

  test('shows generic waiting actions when status is waiting without reason', () => {
    useAppStore.setState({
      selectedThreadId: 't1',
      activeThread: {
        id: 't1',
        projectId: 'p1',
        title: 'Test Thread',
        status: 'waiting',
        cost: 0,
        messages: [],
      } as any,
    });

    renderWithProviders(<ThreadView />);
    expect(screen.getByText('thread.acceptContinue')).toBeInTheDocument();
  });
});
