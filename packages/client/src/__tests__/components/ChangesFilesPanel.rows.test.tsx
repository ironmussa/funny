import type { FileDiffSummary } from '@funny/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { type ComponentProps, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TreeRow } from '@/components/FileTree';
import { ChangesFilesPanel } from '@/components/review-pane/ChangesFilesPanel';

// Characterization tests for the virtualized row renderer of the Changes
// file list: they pin the exact markup and per-row behavior so splitting the
// rows into subcomponents stays a pure refactor.

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
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-mock="tooltip-content">{children}</div>
  ),
}));

// Render dropdown menus inline so every menu item is in the DOM. The menu
// root exposes a "close" button that fires `onOpenChange(false)`.
vi.mock('@/components/ui/dropdown-menu', () => {
  const pass = (name: string) =>
    function Mock({ children, ...props }: { children?: ReactNode; [k: string]: any }) {
      return (
        <div
          data-mock={name}
          data-testid={props['data-testid']}
          className={props.className}
          onClick={props.onClick}
        >
          {children}
        </div>
      );
    };
  return {
    DropdownMenu: ({
      children,
      onOpenChange,
    }: {
      children: ReactNode;
      onOpenChange?: (open: boolean) => void;
    }) => (
      <div data-mock="menu">
        <button data-testid="mock-menu-close" onClick={() => onOpenChange?.(false)} />
        {children}
      </div>
    ),
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
    DropdownMenuContent: pass('content'),
    DropdownMenuItem: pass('item'),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: pass('sub'),
    DropdownMenuSubTrigger: pass('sub-trigger'),
    DropdownMenuSubContent: pass('sub-content'),
  };
});

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

const openExternal = vi.fn();
const openInternal = vi.fn();
vi.mock('@/lib/editor-utils', () => ({
  getEditorLabel: () => 'VS Code',
  openFileInExternalEditor: (p: string) => openExternal(p),
  openFileInInternalEditor: (p: string) => openInternal(p),
}));

function f(path: string, extra: Partial<FileDiffSummary> = {}): FileDiffSummary {
  return { path, status: 'modified', staged: false, additions: 1, deletions: 2, ...extra };
}

const files = {
  added: f('src/a/added.ts', { status: 'added' }),
  modified: f('src/a/modified.ts', { staged: true }),
  deleted: f('src/deleted.ts', { status: 'deleted', additions: undefined }),
  renamed: f('renamed.md', { status: 'renamed', deletions: undefined }),
  conflicted: f('Makefile', { status: 'conflicted' }),
  dotEnd: f('weird.', { status: 'modified' }),
  sub: f('libs/sub', {
    kind: 'submodule',
    nestedDirty: { dirtyFileCount: 3, linesAdded: 7, linesDeleted: 4, pointerMoved: true },
  }),
  subClean: f('libs/clean', {
    kind: 'submodule',
    nestedDirty: { dirtyFileCount: 0, linesAdded: 0, linesDeleted: 0 },
  }),
  subBare: f('bare', { kind: 'submodule' }),
};

const allFiles = Object.values(files);

const treeRows: TreeRow[] = [
  {
    kind: 'folder',
    path: 'src',
    label: 'src',
    depth: 0,
    fileCount: 3,
    additions: 3,
    deletions: 6,
  },
  {
    kind: 'folder',
    path: 'src/a',
    label: 'a',
    depth: 1,
    fileCount: 2,
    additions: 2,
    deletions: 4,
  },
  { kind: 'file', file: files.added, depth: 2 },
  { kind: 'file', file: files.modified, depth: 2 },
  { kind: 'file', file: files.deleted, depth: 1 },
  { kind: 'file', file: files.renamed, depth: 0 },
  { kind: 'file', file: files.conflicted, depth: 0 },
  { kind: 'file', file: files.dotEnd, depth: 0 },
  { kind: 'file', file: files.sub, depth: 1 },
  { kind: 'submodule-status', submodulePath: 'libs/sub', depth: 2, state: 'loading' },
  {
    kind: 'submodule-status',
    submodulePath: 'libs/sub',
    depth: 2,
    state: 'error',
    message: 'boom',
  },
  { kind: 'submodule-status', submodulePath: 'libs/clean', depth: 2, state: 'error' },
  { kind: 'submodule-status', submodulePath: 'bare', depth: 1, state: 'empty' },
  { kind: 'file', file: files.subClean, depth: 1 },
  { kind: 'file', file: files.subBare, depth: 0 },
];

type Props = ComponentProps<typeof ChangesFilesPanel>;

function renderPanel(overrides: Partial<Props> = {}) {
  const props: Props = {
    summaries: allFiles,
    filteredDiffs: allFiles,
    checkedCount: 2,
    totalCount: allFiles.length,
    toggleAll: vi.fn(),
    hasFolders: true,
    allFoldersCollapsed: false,
    collapsedFolders: new Set(['src/a']),
    handleCollapseAllFolders: vi.fn(),
    handleExpandAllFolders: vi.fn(),
    loading: false,
    loadError: false,
    loadErrorMessage: null,
    refresh: vi.fn(),
    fileSearch: 'a',
    treeRows,
    selectedFile: files.modified.path,
    setSelectedFile: vi.fn(),
    expandedFile: files.added.path,
    setExpandedFile: vi.fn(),
    loadDiffForFile: vi.fn(async () => {}),
    checkedFiles: new Set([files.added.path, files.modified.path]),
    toggleFile: vi.fn(),
    toggleFolder: vi.fn(),
    toggleSubmodule: vi.fn(),
    expandedSubmodules: new Set(['libs/sub']),
    fileSelectionState: new Map([[files.modified.path, 'partial' as const]]),
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
  const utils = render(<ChangesFilesPanel {...props} />);
  return { props, ...utils };
}

/** Apply a captured `setState` updater to a seed value. */
function applyUpdater<T>(mockFn: unknown, seed: T): T {
  const call = (mockFn as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  return (call[0] as (prev: T) => T)(seed);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChangesFilesPanel markup', () => {
  it('renders every row variant identically (owner, with basePath)', () => {
    const { container } = renderPanel();
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('renders every row variant identically (read-only, no basePath)', () => {
    const { container } = renderPanel({ readOnly: true, basePath: undefined });
    expect(container.innerHTML).toMatchSnapshot();
  });

  it.each([
    ['all checked', { checkedCount: 9, totalCount: 9 }],
    ['none checked, no folders', { checkedCount: 0, hasFolders: false }],
    ['all collapsed', { allFoldersCollapsed: true, collapsedFolders: new Set<string>() }],
    ['loading empty', { loading: true, summaries: [], filteredDiffs: [], treeRows: [] }],
    ['loading with rows', { loading: true }],
    ['load error', { loadError: true, loadErrorMessage: 'nope' }],
    ['no changes', { summaries: [], filteredDiffs: [], treeRows: [] }],
    ['no matches', { filteredDiffs: [], treeRows: [] }],
  ] as Array<[string, Partial<Props>]>)('renders header/list state: %s', (_name, overrides) => {
    const { container } = renderPanel(overrides);
    expect(container.innerHTML).toMatchSnapshot();
  });
});

describe('ChangesFilesPanel row behavior', () => {
  it('checks an unchecked file and re-selects all lines', () => {
    const { props } = renderPanel({ expandedFile: files.deleted.path });
    fireEvent.click(screen.getByTestId(`review-file-checkbox-${files.deleted.path}`));
    expect(props.toggleFile).toHaveBeenCalledWith(files.deleted.path);
    expect(applyUpdater(props.setSelectAllSignal, 1)).toBe(2);
    expect(applyUpdater(props.setFileSelectionState, new Map()).get(files.deleted.path)).toBe(
      'all',
    );
    expect(props.setDeselectAllSignal).not.toHaveBeenCalled();
  });

  it('upgrades a partial file to fully selected without toggling it', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByTestId(`review-file-checkbox-${files.modified.path}`));
    expect(props.toggleFile).not.toHaveBeenCalled();
    expect(props.setSelectAllSignal).not.toHaveBeenCalled();
    expect(applyUpdater(props.setFileSelectionState, new Map()).get(files.modified.path)).toBe(
      'all',
    );
  });

  it('unchecks a checked file and deselects all lines when expanded', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByTestId(`review-file-checkbox-${files.added.path}`));
    expect(props.toggleFile).toHaveBeenCalledWith(files.added.path);
    expect(applyUpdater(props.setDeselectAllSignal, 4)).toBe(5);
    expect(applyUpdater(props.setFileSelectionState, new Map()).get(files.added.path)).toBe('none');
    expect(props.setSelectAllSignal).not.toHaveBeenCalled();
  });

  it('unchecks a checked, non-expanded file without signalling', () => {
    const { props } = renderPanel({ expandedFile: null });
    fireEvent.click(screen.getByTestId(`review-file-checkbox-${files.added.path}`));
    expect(props.setDeselectAllSignal).not.toHaveBeenCalled();
    expect(props.toggleFile).toHaveBeenCalledWith(files.added.path);
  });

  it('toggles a submodule and folders', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByTestId('review-submodule-toggle-libs/sub'));
    fireEvent.click(screen.getByTestId('review-folder-src/a'));
    expect(props.toggleSubmodule).toHaveBeenCalledWith('libs/sub');
    expect(props.toggleFolder).toHaveBeenCalledWith('src/a');
    expect(props.setSelectedFile).not.toHaveBeenCalled();
  });

  it('ignores a row click right after a dropdown closes', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const { props } = renderPanel();
    fireEvent.click(screen.getAllByTestId('mock-menu-close')[0]);
    fireEvent.click(screen.getByRole('button', { name: `Open diff for ${files.renamed.path}` }));
    expect(props.setSelectedFile).not.toHaveBeenCalled();
    now.mockReturnValue(10_400);
    fireEvent.click(screen.getByRole('button', { name: `Open diff for ${files.renamed.path}` }));
    expect(props.setSelectedFile).toHaveBeenCalledWith(files.renamed.path);
    expect(props.setExpandedFile).toHaveBeenCalledWith(files.renamed.path);
    expect(props.loadDiffForFile).toHaveBeenCalledWith(files.renamed.path);
    now.mockRestore();
  });

  it('routes folder menu actions', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByTestId('review-folder-open-directory-src'));
    fireEvent.click(screen.getByTestId('review-folder-discard-src'));
    fireEvent.click(screen.getByTestId('review-folder-ignore-src'));
    fireEvent.click(screen.getByTestId('review-folder-ignore-src/a-option-/src'));
    expect(props.handleOpenDirectory).toHaveBeenCalledWith('src', false);
    expect(props.handleDiscardFolder).toHaveBeenCalledWith('src');
    expect(vi.mocked(props.handleIgnore).mock.calls).toEqual([['/src'], ['/src']]);
  });

  it('routes file menu actions', () => {
    const { props } = renderPanel();
    const row = (path: string) =>
      screen.getByRole('button', { name: `Open diff for ${path}` }).parentElement!;
    const click = (path: string, label: string) => {
      const item = Array.from(row(path).querySelectorAll('[data-mock="item"]')).find(
        (el) => el.textContent === label,
      );
      if (!item) throw new Error(`missing item ${label} for ${path}`);
      fireEvent.click(item);
    };

    click(files.added.path, 'review.openInEditor');
    fireEvent.click(screen.getByTestId(`review-open-internal-editor-${files.added.path}`));
    fireEvent.click(screen.getByTestId(`review-file-open-directory-${files.added.path}`));
    fireEvent.click(screen.getByTestId(`review-stage-file-${files.added.path}`));
    fireEvent.click(screen.getByTestId(`review-unstage-file-${files.modified.path}`));
    click(files.added.path, 'review.discardChanges');
    click(files.added.path, 'review.ignoreFile');
    click(files.added.path, '/src/a');
    click(files.deleted.path, 'review.ignoreFolder');
    click(files.added.path, 'review.ignoreExtension');
    click(files.added.path, 'review.copyFilePath');
    click(files.added.path, 'review.copyRelativePath');

    expect(openExternal).toHaveBeenCalledWith('/repo/src/a/added.ts');
    expect(openInternal).toHaveBeenCalledWith('/repo/src/a/added.ts');
    expect(props.handleOpenDirectory).toHaveBeenCalledWith(files.added.path, true);
    expect(props.handleStageFile).toHaveBeenCalledWith(files.added.path);
    expect(props.handleUnstageFile).toHaveBeenCalledWith(files.modified.path);
    expect(props.handleRevertFile).toHaveBeenCalledWith(files.added.path);
    expect(vi.mocked(props.handleIgnore).mock.calls).toEqual([
      [files.added.path],
      ['/src/a'],
      ['/src'],
      ['*.ts'],
    ]);
    expect(vi.mocked(props.handleCopyPath).mock.calls).toEqual([
      [files.added.path, false],
      [files.added.path, true],
    ]);
  });

  it('toasts instead of opening an editor when there is no base path', () => {
    renderPanel({ basePath: undefined });
    fireEvent.click(screen.getByTestId(`review-open-internal-editor-${files.added.path}`));
    expect(toastError).toHaveBeenCalledWith('review.openFileNoBasePath');
    expect(openInternal).not.toHaveBeenCalled();
  });
});
