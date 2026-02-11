import { describe, test, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../helpers/render';
import { ReviewPane } from '@/components/ReviewPane';
import { useAppStore } from '@/stores/app-store';
import { okAsync } from 'neverthrow';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getDiff: vi.fn().mockReturnValue(okAsync([])),
    stageFiles: vi.fn().mockReturnValue(okAsync({})),
    unstageFiles: vi.fn().mockReturnValue(okAsync({})),
    revertFiles: vi.fn().mockReturnValue(okAsync({})),
    commit: vi.fn().mockReturnValue(okAsync({})),
    generateCommitMessage: vi.fn().mockReturnValue(okAsync({ message: 'feat: add feature' })),
    push: vi.fn().mockReturnValue(okAsync({})),
    createPR: vi.fn().mockReturnValue(okAsync({})),
    merge: vi.fn().mockReturnValue(okAsync({})),
    listBranches: vi.fn().mockReturnValue(okAsync({ branches: ['main'], defaultBranch: 'main' })),
  },
}));

// Mock the lazy-loaded diff viewer to avoid import issues
vi.mock('@/components/tool-cards/utils', () => ({
  ReactDiffViewer: ({ oldValue, newValue }: any) => (
    <div data-testid="diff-viewer">
      <pre>{oldValue}</pre>
      <pre>{newValue}</pre>
    </div>
  ),
  DIFF_VIEWER_STYLES: {},
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';
const mockApi = vi.mocked(api);

// ── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  useAppStore.setState({
    selectedProjectId: 'p1',
    selectedThreadId: 't1',
    activeThread: {
      id: 't1',
      projectId: 'p1',
      title: 'Test Thread',
      status: 'completed',
      cost: 0,
      branch: 'feature/test',
      mode: 'worktree',
      baseBranch: 'main',
      messages: [],
    } as any,
    reviewPaneOpen: true,
  });
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('ReviewPane', () => {
  test('shows no changes message when diff is empty', async () => {
    mockApi.getDiff.mockReturnValueOnce(okAsync([]));
    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('review.noChanges')).toBeInTheDocument();
    });
  });

  test('renders file list from diffs', async () => {
    mockApi.getDiff.mockReturnValueOnce(okAsync([
      { path: 'src/index.ts', status: 'modified', staged: false, diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new' },
      { path: 'src/utils.ts', status: 'added', staged: true, diff: '+++ b\n+new file' },
    ]));

    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('src/index.ts')).toBeInTheDocument();
      expect(screen.getByText('src/utils.ts')).toBeInTheDocument();
    });

    // Staged/unstaged badges
    expect(screen.getByText('review.staged')).toBeInTheDocument();
    expect(screen.getByText('review.unstaged')).toBeInTheDocument();
  });

  test('stage button calls API and refreshes', async () => {
    mockApi.getDiff
      .mockReturnValueOnce(okAsync([
        { path: 'src/index.ts', status: 'modified', staged: false, diff: '-old\n+new' },
      ]))
      .mockReturnValueOnce(okAsync([
        { path: 'src/index.ts', status: 'modified', staged: true, diff: '-old\n+new' },
      ]));

    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('src/index.ts')).toBeInTheDocument();
    });

    // The "+" button is the stage button for unstaged files
    const stageButtons = screen.getAllByRole('button');
    const stageBtn = stageButtons.find(btn => btn.querySelector('svg.lucide-plus'));
    expect(stageBtn).toBeTruthy();

    fireEvent.click(stageBtn!);

    await waitFor(() => {
      expect(mockApi.stageFiles).toHaveBeenCalledWith('t1', ['src/index.ts']);
    });
  });

  test('unstage button calls API and refreshes', async () => {
    mockApi.getDiff
      .mockReturnValueOnce(okAsync([
        { path: 'src/index.ts', status: 'modified', staged: true, diff: '-old\n+new' },
      ]))
      .mockReturnValueOnce(okAsync([
        { path: 'src/index.ts', status: 'modified', staged: false, diff: '-old\n+new' },
      ]));

    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('src/index.ts')).toBeInTheDocument();
    });

    // The "-" button is the unstage button for staged files
    const unstageButtons = screen.getAllByRole('button');
    const unstageBtn = unstageButtons.find(btn => btn.querySelector('svg.lucide-minus'));
    expect(unstageBtn).toBeTruthy();

    fireEvent.click(unstageBtn!);

    await waitFor(() => {
      expect(mockApi.unstageFiles).toHaveBeenCalledWith('t1', ['src/index.ts']);
    });
  });

  test('commit flow: enter message and commit', async () => {
    mockApi.getDiff
      .mockReturnValueOnce(okAsync([
        { path: 'src/index.ts', status: 'modified', staged: true, diff: '-old\n+new' },
      ]))
      .mockReturnValueOnce(okAsync([]));

    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('src/index.ts')).toBeInTheDocument();
    });

    const commitInput = screen.getByPlaceholderText('review.commitMessage');
    fireEvent.change(commitInput, { target: { value: 'fix: update index' } });
    fireEvent.keyDown(commitInput, { key: 'Enter' });

    await waitFor(() => {
      expect(mockApi.commit).toHaveBeenCalledWith('t1', 'fix: update index');
    });
  });

  test('push calls API and shows toast on success', async () => {
    // No uncommitted changes
    mockApi.getDiff.mockReturnValueOnce(okAsync([]));

    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('review.noChanges')).toBeInTheDocument();
    });

    const pushBtn = screen.getByText('review.push').closest('button');
    expect(pushBtn).not.toBeDisabled();

    fireEvent.click(pushBtn!);

    await waitFor(() => {
      expect(mockApi.push).toHaveBeenCalledWith('t1');
      expect(toast.success).toHaveBeenCalledWith('review.pushedSuccess');
    });
  });

  test('shows branch context with merge target', async () => {
    mockApi.getDiff.mockReturnValueOnce(okAsync([]));

    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      // Branch name displayed (prefix before first / is stripped via .replace(/^[^/]+\//, ''))
      expect(screen.getByText('test')).toBeInTheDocument();
      // Merge target
      expect(screen.getByText('→ main')).toBeInTheDocument();
    });
  });
});
