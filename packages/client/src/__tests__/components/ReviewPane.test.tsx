import { describe, test, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../helpers/render';
import { ReviewPane } from '@/components/ReviewPane';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, any>) =>
      typeof fallbackOrOpts === 'string' ? fallbackOrOpts : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', async () => {
  const { okAsync: ok } = await import('neverthrow');
  return {
    api: {
      getDiff: vi.fn().mockReturnValue(ok([])),
      getDiffSummary: vi.fn().mockReturnValue(ok({ files: [], total: 0, truncated: false })),
      getFileDiff: vi.fn().mockReturnValue(ok({ diff: '' })),
      stageFiles: vi.fn().mockReturnValue(ok({})),
      unstageFiles: vi.fn().mockReturnValue(ok({})),
      revertFiles: vi.fn().mockReturnValue(ok({})),
      commit: vi.fn().mockReturnValue(ok({})),
      generateCommitMessage: vi.fn().mockReturnValue(ok({ title: 'feat: add feature', body: '' })),
      push: vi.fn().mockReturnValue(ok({})),
      createPR: vi.fn().mockReturnValue(ok({})),
      merge: vi.fn().mockReturnValue(ok({})),
      listBranches: vi.fn().mockReturnValue(ok({ branches: ['main'], defaultBranch: 'main' })),
      stashList: vi.fn().mockReturnValue(ok({ entries: [] })),
      stash: vi.fn().mockReturnValue(ok({})),
      stashPop: vi.fn().mockReturnValue(ok({})),
      pull: vi.fn().mockReturnValue(ok({})),
      getGitLog: vi.fn().mockReturnValue(ok({ entries: [] })),
      resetSoft: vi.fn().mockReturnValue(ok({})),
      addToGitignore: vi.fn().mockReturnValue(ok({})),
      sendMessage: vi.fn().mockReturnValue(ok({})),
      openInEditor: vi.fn().mockReturnValue(ok({})),
      getGitStatus: vi.fn().mockReturnValue(ok({ ahead: 0, behind: 0, branch: 'feature/test', baseBranch: 'main', hasConflicts: false })),
      getGitStatuses: vi.fn().mockReturnValue(ok({ statuses: [] })),
    },
  };
});

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

vi.mock('@/hooks/use-auto-refresh-diff', () => ({
  useAutoRefreshDiff: vi.fn(),
}));

// Mock @tanstack/react-virtual so the virtualizer renders all items in jsdom (no layout)
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: any) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        key: i,
        start: i * 28,
        size: 28,
      })),
    getTotalSize: () => opts.count * 28,
    measureElement: () => {},
  }),
}));

import { api } from '@/lib/api';
const mockApi = vi.mocked(api);

// ── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  useProjectStore.setState({
    selectedProjectId: 'p1',
  });
  useThreadStore.setState({
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
    threadsByProject: {
      p1: [{ id: 't1', projectId: 'p1', status: 'completed' } as any],
    },
  });
  useUIStore.setState({
    reviewPaneOpen: true,
  });
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('ReviewPane', () => {
  test('shows no changes message when diff is empty', async () => {
    const { okAsync: ok } = await import('neverthrow');
    mockApi.getDiffSummary.mockReturnValueOnce(ok({ files: [], total: 0, truncated: false } as any) as any);
    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('review.noChanges')).toBeInTheDocument();
    });
  });

  test('renders file list from diffs', async () => {
    const { okAsync: ok } = await import('neverthrow');
    mockApi.getDiffSummary.mockReturnValueOnce(ok({
      files: [
        { path: 'src/index.ts', status: 'modified', staged: false },
        { path: 'src/utils.ts', status: 'added', staged: false },
      ],
      total: 2,
      truncated: false,
    } as any) as any);

    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('src/index.ts')).toBeInTheDocument();
      expect(screen.getByText('src/utils.ts')).toBeInTheDocument();
    });

    // Status indicators: M for modified, A for added
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  test('shows commit controls when there are diffs', async () => {
    const { okAsync: ok } = await import('neverthrow');
    mockApi.getDiffSummary.mockReturnValueOnce(ok({
      files: [
        { path: 'src/index.ts', status: 'modified', staged: false },
      ],
      total: 1,
      truncated: false,
    } as any) as any);

    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('src/index.ts')).toBeInTheDocument();
    });

    // Commit title input
    expect(screen.getByPlaceholderText('review.commitTitle')).toBeInTheDocument();
    // Commit body textarea
    expect(screen.getByPlaceholderText('review.commitBody')).toBeInTheDocument();
    // Action buttons (use fallback strings from t() calls)
    expect(screen.getByText('Commit')).toBeInTheDocument();
    expect(screen.getByText('Commit & Push')).toBeInTheDocument();
    expect(screen.getByText('Commit & Create PR')).toBeInTheDocument();
  });

  test('shows header with title and close button', async () => {
    const { okAsync: ok } = await import('neverthrow');
    mockApi.getDiffSummary.mockReturnValueOnce(ok({ files: [], total: 0, truncated: false } as any) as any);
    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('review.title')).toBeInTheDocument();
    });
  });

  test('shows select file prompt when no file selected and diffs exist', async () => {
    const { okAsync: ok } = await import('neverthrow');
    // When diffs exist, the first file gets auto-selected. With no diff content,
    // the diff viewer shows the file's diff content
    mockApi.getDiffSummary.mockReturnValueOnce(ok({
      files: [
        { path: 'src/index.ts', status: 'modified', staged: false },
      ],
      total: 1,
      truncated: false,
    } as any) as any);
    mockApi.getFileDiff.mockReturnValueOnce(ok({ diff: '' } as any) as any);

    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('src/index.ts')).toBeInTheDocument();
    });

    // With empty diff string, shows binary/no diff message
    expect(screen.getByText('review.binaryOrNoDiff')).toBeInTheDocument();
  });

  test('shows file count selection', async () => {
    const { okAsync: ok } = await import('neverthrow');
    mockApi.getDiffSummary.mockReturnValueOnce(ok({
      files: [
        { path: 'src/a.ts', status: 'modified', staged: false },
        { path: 'src/b.ts', status: 'added', staged: false },
      ],
      total: 2,
      truncated: false,
    } as any) as any);

    renderWithProviders(<ReviewPane />);

    await waitFor(() => {
      expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    });

    // Shows selected count "2/2 selected"
    expect(screen.getByText(/2\/2/)).toBeInTheDocument();
  });
});
