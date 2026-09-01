import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { FileSearchDialog } from '@/components/FileSearchDialog';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const mocks = vi.hoisted(() => ({
  rankedSearch: vi.fn(),
  trackFileSelection: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/hooks/use-ranked-file-search', () => ({
  useRankedFileSearch: mocks.rankedSearch,
}));

vi.mock('@/lib/api', () => ({
  api: { trackFileSelection: mocks.trackFileSelection },
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 32,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 32,
        start: index * 32,
      })),
    scrollToIndex: vi.fn(),
  }),
}));

describe('FileSearchDialog', () => {
  const openFile = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({
      selectedProjectId: 'project-1',
      projects: [{ id: 'project-1', path: '/repo' }],
    } as never);
    useThreadStore.setState({ activeThread: null, threadDataById: {} } as never);
    useInternalEditorStore.setState({ openFile });
    mocks.rankedSearch.mockReturnValue({
      response: {
        matches: [{ path: 'src/app.ts', indices: [4, 5, 6] }],
        total: 1,
        truncated: false,
        basePath: '/repo',
      },
      searching: false,
      error: null,
    });
  });

  test('renders ranked server results and opens a selected project file', () => {
    const onOpenChange = vi.fn();
    renderWithProviders(<FileSearchDialog open onOpenChange={onOpenChange} />);

    expect(screen.getByTestId('file-search-item-src/app.ts')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('file-search-input'), { target: { value: 'app' } });
    fireEvent.click(screen.getByTestId('file-search-item-src/app.ts'));

    expect(openFile).toHaveBeenCalledWith('/repo/src/app.ts');
    expect(mocks.trackFileSelection).toHaveBeenCalledWith({ path: '/repo' }, 'app', 'src/app.ts');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('opens the active result from the keyboard', () => {
    const onOpenChange = vi.fn();
    renderWithProviders(<FileSearchDialog open onOpenChange={onOpenChange} />);

    const result = screen.getByTestId('file-search-item-src/app.ts');
    expect(result).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(result, { key: 'Enter' });

    expect(openFile).toHaveBeenCalledWith('/repo/src/app.ts');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('highlights a complete filename match instead of partial path characters', () => {
    mocks.rankedSearch.mockReturnValue({
      response: {
        matches: [
          {
            path: 'packages/client/src/hooks/use-slash-skills.ts',
            indices: [30, 31, 32, 33, 34],
          },
        ],
        total: 1,
        truncated: false,
        basePath: '/repo',
      },
      searching: false,
      error: null,
    });

    renderWithProviders(<FileSearchDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId('file-search-input'), { target: { value: 'slash' } });

    const item = screen.getByTestId(
      'file-search-item-packages/client/src/hooks/use-slash-skills.ts',
    );
    expect(Array.from(item.querySelectorAll('mark'), (mark) => mark.textContent)).toEqual([
      'slash',
      'slash',
    ]);
  });

  test('uses the server-resolved scratch base path when opening a result', () => {
    const scratchThread = {
      id: 'scratch-1',
      isScratch: true,
      projectId: null,
      worktreePath: null,
      messages: [],
      threadEvents: [],
      compactionEvents: [],
    };
    useThreadStore.setState({
      activeThread: scratchThread,
      threadDataById: { 'scratch-1': scratchThread },
    } as never);
    mocks.rankedSearch.mockReturnValue({
      response: {
        matches: [{ path: 'notes/todo.md', indices: [6, 7, 8] }],
        total: 1,
        truncated: false,
        basePath: '/runner/scratch/user-1/scratch-1',
      },
      searching: false,
      error: null,
    });

    renderWithProviders(<FileSearchDialog open onOpenChange={vi.fn()} />, {
      threadId: 'scratch-1',
    });
    fireEvent.click(screen.getByTestId('file-search-item-notes/todo.md'));

    expect(openFile).toHaveBeenCalledWith('/runner/scratch/user-1/scratch-1/notes/todo.md');
    expect(mocks.trackFileSelection).toHaveBeenCalledWith(
      { threadId: 'scratch-1' },
      '',
      'notes/todo.md',
    );
  });

  test('renders a controlled server error without file results', () => {
    mocks.rankedSearch.mockReturnValue({
      response: null,
      searching: false,
      error: 'File search is unavailable',
    });

    renderWithProviders(<FileSearchDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText('File search is unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });
});
