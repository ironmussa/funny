import { fireEvent, screen } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { NewThreadInput } from '@/components/thread/NewThreadInput';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const mockCreateThread = vi.fn().mockResolvedValue(true);
const mockNavigate = vi.fn();

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

vi.mock('@/components/PromptInput', () => ({
  PromptInput: (props: {
    onSubmit?: () => void;
    onWorktreeModeChange?: (value: boolean) => void;
    onContentChange?: (hasContent: boolean, text: string) => void;
    initialPrompt?: string;
  }) => (
    <div data-testid="mock-prompt-input">
      {props.initialPrompt ? <span data-testid="initial-prompt">{props.initialPrompt}</span> : null}
      <button type="button" data-testid="mock-prompt-submit" onClick={() => props.onSubmit?.()}>
        Submit
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
    </div>
  ),
}));

describe('NewThreadInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  test('shows worktree branch preview when worktree mode is enabled', () => {
    renderWithProviders(<NewThreadInput projectIdOverride="p1" />);

    fireEvent.click(screen.getByTestId('mock-worktree-toggle'));
    fireEvent.click(screen.getByTestId('mock-content-change'));

    expect(screen.getByTestId('worktree-preview')).toBeInTheDocument();
    expect(screen.getByTestId('worktree-preview')).toHaveTextContent(
      'my-project/build-feature-x-xxxxxx',
    );
  });
});
