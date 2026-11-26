import type { FileDiffSummary } from '@funny/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/ui/toast';
import { browseApi as api } from '@/lib/api/browse';
import { createClientLogger } from '@/lib/client-logger';
import { buildTreeRows, type TreeRow } from '@/lib/file-tree';

import { FileTreeFileRow } from './file-tree/FileTreeFileRow';
import { FileTreeFolderRow } from './file-tree/FileTreeFolderRow';
import { FileTreeSubmoduleStatusRow } from './file-tree/FileTreeSubmoduleStatusRow';
import type { FileTreeRowCommon } from './file-tree/row-props';

const log = createClientLogger('file-tree');

export type { TreeRow } from '@/lib/file-tree';

const ROW_HEIGHT = 24; // h-6 = 1.5rem = 24px

/* ── Props ── */

export interface FileTreeProps {
  /** Flat list of file diffs to display as a tree */
  files: FileDiffSummary[];
  /** Currently active/selected file path */
  selectedFile?: string | null;
  /** Callback when a file row is clicked */
  onFileClick: (path: string) => void;
  /** Set of checked file paths (enables checkboxes when provided) */
  checkedFiles?: Set<string>;
  /** Toggle a file's checked state */
  onToggleFile?: (path: string) => void;
  /** Revert/discard a file (enables discard menu item when provided) */
  onRevertFile?: (path: string) => void;
  /** Custom label for the revert action (default: uses t('review.discardChanges')) */
  revertLabel?: string;
  /** Add a pattern to .gitignore (enables ignore menu items when provided) */
  onIgnore?: (pattern: string) => void;
  /** Base path for constructing absolute file paths (for open-in-editor) */
  basePath?: string;
  /** DiffStats size variant */
  diffStatsSize?: 'sm' | 'xs' | 'xxs';
  /** Font size class for labels (default: "text-xs") */
  fontSize?: string;
  /** CSS class for the active-file highlight */
  activeClass?: string;
  /** CSS class for hover on inactive rows */
  hoverClass?: string;
  /** data-testid prefix (default: "filetree") */
  testIdPrefix?: string;
  /** Enable virtual scrolling for large file lists. The FileTree must be placed inside a fixed-height scroll container. */
  virtualize?: boolean;
  /** Search query to highlight matching text in file/folder names */
  searchQuery?: string;
  /** Hide the per-file status letter (A/M/D/R). Use when rows don't represent git changes. */
  hideStatus?: boolean;
  /** Hide the per-file and per-folder diff stats (+/-). Use when rows don't represent git changes. */
  hideDiffStats?: boolean;
  /** Controlled collapsed-folders set. Omit for internal state. */
  collapsedFolders?: Set<string>;
  /** Callback when a folder is toggled (only used in controlled mode). */
  onCollapsedFoldersChange?: (next: Set<string>) => void;
  /**
   * When provided, submodule entries become expandable: clicking the chevron
   * calls this with the submodule's path (relative to the git root). The
   * caller is expected to fetch the submodule's inner file list and pass it
   * back via `submoduleExpansions`.
   */
  onToggleSubmodule?: (submodulePath: string) => void;
  /** Map of submodule path → loaded inner file list (path relative to the submodule). */
  submoduleExpansions?: Map<string, FileDiffSummary[]>;
  /** Map of submodule path → loading/error state for the inner file list. */
  submoduleStates?: Map<string, { state: 'loading' | 'error' | 'empty'; message?: string }>;
  /** Set of submodule paths that are currently expanded (presence = expanded). */
  expandedSubmodules?: Set<string>;
}

/* ── Component ── */

export function FileTree({
  files,
  selectedFile,
  onFileClick,
  checkedFiles,
  onToggleFile,
  onRevertFile,
  revertLabel,
  onIgnore,
  basePath,
  diffStatsSize = 'xs',
  fontSize = 'text-xs',
  activeClass = 'bg-sidebar-accent text-sidebar-accent-foreground',
  hoverClass = 'hover:bg-sidebar-accent/50 text-muted-foreground',
  testIdPrefix = 'filetree',
  virtualize = false,
  searchQuery,
  hideStatus = false,
  hideDiffStats = false,
  collapsedFolders: collapsedFoldersProp,
  onCollapsedFoldersChange,
  onToggleSubmodule,
  submoduleExpansions,
  submoduleStates,
  expandedSubmodules,
}: FileTreeProps) {
  const { t } = useTranslation();
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(new Set());
  const collapsedFolders = collapsedFoldersProp ?? internalCollapsed;
  const dropdownCloseRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const treeRows = useMemo(
    () =>
      buildTreeRows(
        files,
        collapsedFolders,
        submoduleExpansions,
        submoduleStates,
        expandedSubmodules,
      ),
    [files, collapsedFolders, submoduleExpansions, submoduleStates, expandedSubmodules],
  );

  const virtualizer = useVirtualizer({
    count: virtualize ? treeRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => {
      const row = treeRows[index];
      if (row.kind === 'folder') return `d:${row.path}`;
      if (row.kind === 'submodule-status') return `s:${row.submodulePath}:${row.state}`;
      return `f:${row.file.path}`;
    },
    overscan: 15,
    enabled: virtualize,
  });

  const toggleFolder = useCallback(
    (folderPath: string) => {
      if (collapsedFoldersProp && onCollapsedFoldersChange) {
        const next = new Set(collapsedFoldersProp);
        if (next.has(folderPath)) next.delete(folderPath);
        else next.add(folderPath);
        onCollapsedFoldersChange(next);
        return;
      }
      setInternalCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(folderPath)) next.delete(folderPath);
        else next.add(folderPath);
        return next;
      });
    },
    [collapsedFoldersProp, onCollapsedFoldersChange],
  );

  const handleCopyPath = useCallback(
    (path: string, relative: boolean) => {
      const text = relative ? path : `/${path}`;
      navigator.clipboard.writeText(text);
      toast.success(t('review.pathCopied'));
    },
    [t],
  );

  const handleOpenDirectory = useCallback(
    async (relativePath: string, isFile: boolean) => {
      if (!basePath) return;
      const dirRelative = isFile
        ? relativePath.includes('/')
          ? relativePath.slice(0, relativePath.lastIndexOf('/'))
          : ''
        : relativePath;
      const absoluteDir = dirRelative ? `${basePath}/${dirRelative}` : basePath;
      const result = await api.openDirectory({ path: absoluteDir });
      if (result.isErr()) {
        log.error('Failed to open directory', {
          path: absoluteDir,
          error: String(result.error),
        });
        toast.error(t('review.openDirectoryError', 'Failed to open directory'), {
          description: result.error.message,
        });
      }
    },
    [basePath, t],
  );

  const common: FileTreeRowCommon = {
    fontSize,
    hoverClass,
    testIdPrefix,
    searchQuery,
    hideStatus,
    hideDiffStats,
    diffStatsSize,
    basePath,
    dropdownCloseRef,
    onCopyPath: handleCopyPath,
    onOpenDirectory: handleOpenDirectory,
  };

  const renderRow = (row: TreeRow) => {
    if (row.kind === 'submodule-status') {
      return (
        <FileTreeSubmoduleStatusRow
          key={`submodule-status-${row.submodulePath}-${row.state}`}
          row={row}
          common={common}
        />
      );
    }
    if (row.kind === 'folder') {
      return (
        <FileTreeFolderRow
          key={`folder-${row.path}`}
          row={row}
          common={common}
          isCollapsed={collapsedFolders.has(row.path)}
          onToggleFolder={toggleFolder}
        />
      );
    }
    return (
      <FileTreeFileRow
        key={row.file.path}
        row={row}
        common={common}
        isActive={row.file.path === selectedFile}
        activeClass={activeClass}
        onFileClick={onFileClick}
        checkedFiles={checkedFiles}
        onToggleFile={onToggleFile}
        onRevertFile={onRevertFile}
        revertLabel={revertLabel}
        onIgnore={onIgnore}
        onToggleSubmodule={onToggleSubmodule}
        expandedSubmodules={expandedSubmodules}
      />
    );
  };

  /* ── Virtualized rendering ── */

  if (virtualize) {
    return (
      <div ref={scrollRef} className="h-full overflow-auto">
        <div
          className="relative h-[var(--file-tree-total-height)] w-full"
          style={{ '--file-tree-total-height': `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = treeRows[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                className="absolute top-0 left-0 h-[var(--file-tree-row-height)] w-full [transform:translateY(var(--file-tree-row-start))]"
                style={{
                  '--file-tree-row-height': `${virtualRow.size}px`,
                  '--file-tree-row-start': `${virtualRow.start}px`,
                }}
              >
                {renderRow(row)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  /* ── Non-virtualized (original) rendering ── */

  return <>{treeRows.map((row) => renderRow(row))}</>;
}
