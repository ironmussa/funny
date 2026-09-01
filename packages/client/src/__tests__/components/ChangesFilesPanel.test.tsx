import type { FileDiffSummary } from '@funny/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { type ComponentProps, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ChangesFilesPanel } from '@/components/review-pane/ChangesFilesPanel';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 24,
        start: index * 24,
      })),
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => children,
}));

const file = {
  path: 'src/example.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
} as FileDiffSummary;

function renderPanel(overrides: Partial<ComponentProps<typeof ChangesFilesPanel>> = {}) {
  const props: ComponentProps<typeof ChangesFilesPanel> = {
    summaries: [file],
    filteredDiffs: [file],
    checkedCount: 0,
    totalCount: 1,
    toggleAll: vi.fn(),
    hasFolders: true,
    allFoldersCollapsed: false,
    collapsedFolders: new Set(['src']),
    handleCollapseAllFolders: vi.fn(),
    handleExpandAllFolders: vi.fn(),
    loading: false,
    loadError: false,
    loadErrorMessage: null,
    refresh: vi.fn(),
    fileSearch: '',
    treeRows: [
      {
        kind: 'folder',
        path: 'src',
        label: 'src',
        depth: 0,
        fileCount: 1,
        additions: 2,
        deletions: 1,
      },
      { kind: 'file', file, depth: 1 },
    ],
    selectedFile: null,
    setSelectedFile: vi.fn(),
    expandedFile: null,
    setExpandedFile: vi.fn(),
    loadDiffForFile: vi.fn(async () => {}),
    checkedFiles: new Set(),
    toggleFile: vi.fn(),
    toggleFolder: vi.fn(),
    toggleSubmodule: vi.fn(),
    expandedSubmodules: new Set(),
    fileSelectionState: new Map(),
    setFileSelectionState: vi.fn(),
    setSelectAllSignal: vi.fn(),
    setDeselectAllSignal: vi.fn(),
    handleStageFile: vi.fn(),
    handleUnstageFile: vi.fn(),
    handleRevertFile: vi.fn(),
    handleDiscardFolder: vi.fn(),
    handleIgnore: vi.fn(),
    handleCopyPath: vi.fn(),
    handleOpenDirectory: vi.fn(),
    basePath: '/repo',
    ...overrides,
  };

  render(<ChangesFilesPanel {...props} />);
  return props;
}

describe('ChangesFilesPanel keyboard accessibility', () => {
  it('uses focusable native buttons for folder and file row activation', () => {
    const props = renderPanel();

    const folder = screen.getByTestId('review-folder-src');
    expect(folder.tagName).toBe('BUTTON');
    folder.focus();
    expect(folder).toHaveFocus();
    fireEvent.click(folder);

    const fileButton = screen.getByRole('button', { name: 'Open diff for src/example.ts' });
    expect(fileButton.tagName).toBe('BUTTON');
    fileButton.focus();
    expect(fileButton).toHaveFocus();
    fireEvent.click(fileButton);

    expect(props.toggleFolder).toHaveBeenCalledWith('src');
    expect(props.setSelectedFile).toHaveBeenCalledWith('src/example.ts');
    expect(props.setExpandedFile).toHaveBeenCalledWith('src/example.ts');
    expect(props.loadDiffForFile).toHaveBeenCalledWith('src/example.ts');
  });

  it('keeps checkbox and menu activation isolated from the file button', () => {
    const setSelectedFile = vi.fn();
    const loadDiffForFile = vi.fn(async () => {});
    const toggleFile = vi.fn();
    renderPanel({ setSelectedFile, loadDiffForFile, toggleFile });

    fireEvent.click(screen.getByTestId('review-file-checkbox-src/example.ts'));
    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' }).at(-1)!);

    expect(toggleFile).toHaveBeenCalledWith('src/example.ts');
    expect(setSelectedFile).not.toHaveBeenCalled();
    expect(loadDiffForFile).not.toHaveBeenCalled();
  });
});
