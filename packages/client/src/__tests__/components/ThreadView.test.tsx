import { describe, test, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../helpers/render';
import { ThreadView } from '@/components/ThreadView';
import { useAppStore } from '@/stores/app-store';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    sendMessage: vi.fn().mockResolvedValue({}),
    stopThread: vi.fn().mockResolvedValue({}),
    listBranches: vi.fn().mockResolvedValue({ branches: [], defaultBranch: 'main' }),
    listWorktrees: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue({ skills: [] }),
  },
}));

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
    <div data-testid="agent-result-card">{status} - ${cost}</div>
  ),
  AgentInterruptedCard: () => <div data-testid="agent-interrupted-card" />,
}));

// ── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  useAppStore.setState({
    projects: [{ id: 'p1', name: 'Test', path: '/tmp/test', userId: '__local__', createdAt: '' }],
    selectedProjectId: 'p1',
    selectedThreadId: null,
    activeThread: null,
    newThreadProjectId: null,
  });
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('ThreadView', () => {
  test('shows empty state when no thread selected', () => {
    renderWithProviders(<ThreadView />);
    expect(screen.getByText('thread.selectOrCreate')).toBeInTheDocument();
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

    expect(screen.getByText('Hello agent')).toBeInTheDocument();
    expect(screen.getByText('Hello human')).toBeInTheDocument();
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

    // ToolCallCard renders the tool label (translated key)
    expect(screen.getByText('tools.readFile')).toBeInTheDocument();
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

  test('shows waiting actions when status is waiting', () => {
    useAppStore.setState({
      selectedThreadId: 't1',
      activeThread: {
        id: 't1',
        projectId: 'p1',
        title: 'Test Thread',
        status: 'waiting',
        waitingReason: 'plan',
        cost: 0,
        messages: [],
      } as any,
    });

    renderWithProviders(<ThreadView />);
    expect(screen.getByText('thread.acceptContinue')).toBeInTheDocument();
  });
});
