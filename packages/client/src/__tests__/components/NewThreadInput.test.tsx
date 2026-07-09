import { fireEvent, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import type { ReactNode } from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { NewThreadInput } from '@/components/thread/NewThreadInput';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const mockCreateThread = vi.fn().mockResolvedValue(true);
const mockNavigate = vi.fn();
const mockListMcpServers = vi.hoisted(() => vi.fn());
const mockCreateIdleThread = vi.hoisted(() => vi.fn());
const mockRunWorkflow = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/hooks/use-thread-creation', () => ({
  useThreadCreation: () => ({
    creating: false,
    createThread: mockCreateThread,
  }),
}));

vi.mock('@/hooks/use-save-backlog-on-leave', () => ({
  useSaveBacklogOnLeave: () => ({
    blocker: { state: 'unblocked' },
    savingBacklog: false,
    handleSaveToBacklog: vi.fn(),
    handleDiscard: vi.fn(),
    handleCancel: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-branch-switch', () => ({
  useBranchSwitch: () => ({
    ensureBranch: vi.fn().mockResolvedValue(true),
    branchSwitchDialog: null,
  }),
}));

vi.mock('@/lib/api', async () => {
  const { okAsync: okAsyncResult } = await import('neverthrow');
  return {
    api: {
      listMcpServers: mockListMcpServers,
      createIdleThread: mockCreateIdleThread,
      runWorkflow: mockRunWorkflow,
      listThreads: vi.fn().mockReturnValue(okAsyncResult({ threads: [], total: 0 })),
      remoteUrl: vi.fn().mockReturnValue(okAsyncResult({ url: '' })),
    },
  };
});

vi.mock('@/components/PromptInput', () => ({
  PromptInput: (props: {
    onSubmit?: (prompt: string, opts: { model: string; mode: string; threadMode: string }) => void;
    onWorktreeModeChange?: (value: boolean) => void;
    onContentChange?: (hasContent: boolean, text: string) => void;
    onProviderChange?: (provider: string) => void;
    initialPrompt?: string;
    newThreadContextBar?: ReactNode;
  }) => (
    <div data-testid="mock-prompt-input">
      {props.newThreadContextBar ? (
        <div data-testid="new-thread-context-bar">{props.newThreadContextBar}</div>
      ) : null}
      {props.initialPrompt ? <span data-testid="initial-prompt">{props.initialPrompt}</span> : null}
      <button
        type="button"
        data-testid="mock-prompt-submit"
        onClick={() =>
          props.onSubmit?.('Build feature X', {
            model: 'gpt-5',
            mode: 'auto',
            threadMode: 'local',
          })
        }
      >
        Submit
      </button>
      <button
        type="button"
        data-testid="mock-workflow-submit"
        onClick={() =>
          props.onSubmit?.('>> fusion review this branch', {
            model: 'gpt-5',
            mode: 'auto',
            threadMode: 'local',
          })
        }
      >
        Workflow
      </button>
      <button
        type="button"
        data-testid="mock-worktree-toggle"
        onClick={() => props.onWorktreeModeChange?.(true)}
      >
        Worktree
      </button>
      <button
        type="button"
        data-testid="mock-content-change"
        onClick={() => props.onContentChange?.(true, 'Build feature X')}
      >
        Type
      </button>
      <button
        type="button"
        data-testid="mock-same-provider-model"
        onClick={() => props.onProviderChange?.('codex')}
      >
        Codex model
      </button>
      <button
        type="button"
        data-testid="mock-other-provider-model"
        onClick={() => props.onProviderChange?.('claude')}
      >
        Claude model
      </button>
    </div>
  ),
}));

describe('NewThreadInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListMcpServers.mockReturnValue(okAsync({ servers: [] }));
    mockCreateIdleThread.mockReturnValue(
      okAsync({
        id: 'thread-workflow',
        projectId: 'p1',
        title: 'review this branch',
        status: 'idle',
      }),
    );
    mockRunWorkflow.mockReturnValue(okAsync({ runId: 'run-1', pipelineRunId: 'run-1' }));
    useUIStore.setState({
      newThreadIsScratch: false,
      newThreadProjectId: null,
      newThreadIdleOnly: false,
      composePrefillPrompt: null,
      newThreadIssueContext: null,
      activeDesignId: null,
    } as any);
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'My Project', path: '/repo', defaultMode: 'local' } as any],
      selectedProjectId: 'p1',
    });
    useBranchPickerStore.setState({
      branches: ['main', 'develop'],
      remoteBranches: [],
      defaultBranch: 'main',
      selectedBranch: 'main',
      currentBranch: 'main',
      loading: false,
    });
  });

  test('renders scratch compose UI when scratch mode is active', () => {
    renderWithProviders(<NewThreadInput isScratchOverride />);

    expect(screen.getByTestId('new-thread-scratch')).toBeInTheDocument();
    expect(screen.getByTestId('new-thread-scratch-label')).toHaveTextContent('New scratch thread');
    expect(screen.getByTestId('new-thread-scratch-prompt')).toBeInTheDocument();
  });

  test('renders project context bar for normal compose', () => {
    renderWithProviders(<NewThreadInput projectIdOverride="p1" />);

    expect(screen.getByTestId('new-thread-context-bar')).toBeInTheDocument();
    expect(screen.getByTestId('mock-prompt-input')).toBeInTheDocument();
    expect(screen.getByTestId('new-thread-branch-picker')).toBeInTheDocument();
  });

  test('uses the explicit new-thread project before the globally selected project', async () => {
    useUIStore.setState({ newThreadProjectId: 'p2' } as any);
    useProjectStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'Project One',
          path: '/repo-one',
          defaultMode: 'local',
          defaultProvider: 'codex',
        } as any,
        {
          id: 'p2',
          name: 'Project Two',
          path: '/repo-two',
          defaultMode: 'local',
          defaultProvider: 'codex',
        } as any,
      ],
      selectedProjectId: 'p1',
    });

    renderWithProviders(<NewThreadInput />);

    await waitFor(() => {
      expect(mockListMcpServers).toHaveBeenCalledWith('/repo-two', 'codex', 'p2');
    });
  });

  test('shows issue context banner and allows dismiss', () => {
    useUIStore.setState({
      newThreadIssueContext: { title: 'Bug #42', prompt: 'Fix it' },
    } as any);

    renderWithProviders(<NewThreadInput projectIdOverride="p1" />);

    expect(screen.getByTestId('issue-context-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('issue-context-dismiss'));
    expect(useUIStore.getState().newThreadIssueContext).toBeNull();
  });

  test('uses compose prefill prompt once on mount', () => {
    useUIStore.setState({ composePrefillPrompt: 'Prefilled prompt' } as any);

    renderWithProviders(<NewThreadInput projectIdOverride="p1" />);

    expect(screen.getByTestId('initial-prompt')).toHaveTextContent('Prefilled prompt');
    expect(useUIStore.getState().composePrefillPrompt).toBeNull();
  });

  test('keeps the loader pinned after a successful submit (no compose flash)', async () => {
    // Regression: the hook flips `creating` back to false as soon as the create
    // resolves, but react-router's URL commit (which unmounts this form) lands a
    // render later. The component must keep showing "Preparing…" — not flash the
    // empty compose form — until it unmounts.
    mockCreateThread.mockResolvedValueOnce(true);
    renderWithProviders(<NewThreadInput projectIdOverride="p1" />);

    expect(screen.getByTestId('mock-prompt-input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mock-prompt-submit'));

    await waitFor(() => expect(screen.getByTestId('new-thread-creating')).toBeInTheDocument());
    // Compose form is gone — the loader replaced it even though the mocked hook
    // reports `creating: false`.
    expect(screen.queryByTestId('mock-prompt-input')).not.toBeInTheDocument();
  });

  test('does NOT pin the loader for idle (backlog) submits', async () => {
    // Idle creates stay on this screen (no navigation), so the loader must not
    // stick — otherwise the compose form would be replaced by a stuck spinner.
    useUIStore.setState({ newThreadIdleOnly: true } as any);
    mockCreateThread.mockResolvedValueOnce(true);
    renderWithProviders(<NewThreadInput projectIdOverride="p1" />);

    fireEvent.click(screen.getByTestId('mock-prompt-submit'));

    await waitFor(() => expect(mockCreateThread).toHaveBeenCalled());
    expect(screen.queryByTestId('new-thread-creating')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-prompt-input')).toBeInTheDocument();
  });

  test('creates an idle thread and runs workflow for >> invocations', async () => {
    renderWithProviders(<NewThreadInput projectIdOverride="p1" />);

    fireEvent.click(screen.getByTestId('mock-workflow-submit'));

    await waitFor(() => {
      expect(mockCreateIdleThread).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'p1',
          title: 'review this branch',
          mode: 'local',
          prompt: 'review this branch',
        }),
      );
    });
    expect(mockRunWorkflow).toHaveBeenCalledWith('fusion', {
      threadId: 'thread-workflow',
      prompt: 'review this branch',
      inputs: undefined,
    });
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  test('shows worktree branch preview when worktree mode is enabled', () => {
    renderWithProviders(<NewThreadInput projectIdOverride="p1" />);

    fireEvent.click(screen.getByTestId('mock-worktree-toggle'));
    fireEvent.click(screen.getByTestId('mock-content-change'));

    expect(screen.getByTestId('worktree-preview')).toBeInTheDocument();
    expect(screen.getByTestId('worktree-preview')).toHaveTextContent(
      'my-project/build-feature-x-xxxxxx',
    );
  });

  test('reloads available MCP servers only when the selected provider changes', async () => {
    useProjectStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'My Project',
          path: '/repo',
          defaultMode: 'local',
          defaultProvider: 'codex',
        } as any,
      ],
      selectedProjectId: 'p1',
    });

    renderWithProviders(<NewThreadInput projectIdOverride="p1" />);

    await waitFor(() => {
      expect(mockListMcpServers).toHaveBeenCalledWith('/repo', 'codex', 'p1');
    });
    expect(mockListMcpServers).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('mock-same-provider-model'));
    expect(mockListMcpServers).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('mock-other-provider-model'));
    await waitFor(() => {
      expect(mockListMcpServers).toHaveBeenCalledWith('/repo', 'claude', 'p1');
    });
    expect(mockListMcpServers).toHaveBeenCalledTimes(2);
  });
});
