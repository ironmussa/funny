import type { FileDiffSummary } from '@funny/shared';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  FileCheck2,
  FolderMinus,
  FolderOpen,
  RotateCcw,
  Search,
} from 'lucide-react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { TreeRow } from '@/components/FileTree';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TriCheckbox } from '@/components/ui/tri-checkbox';
import { cn } from '@/lib/utils';

import { ChangesFileRow, type ChangesFileRowContext } from './ChangesFileRow';
import { ChangesFolderRow } from './ChangesFolderRow';
import { SubmoduleStatusRowView } from './ChangesRowParts';

const FILE_ROW_HEIGHT = 24;
const FOLDER_ROW_HEIGHT = 24;
/** A row click within this window after a row menu closes is ignored. */
const MENU_CLOSE_CLICK_GUARD_MS = 400;

function treeRowKey(row: TreeRow): string {
  if (row.kind === 'folder') return `d:${row.path}`;
  if (row.kind === 'submodule-status') return `s:${row.submodulePath}:${row.state}`;
  return `f:${row.file.path}`;
}

function selectAllState(checkedCount: number, totalCount: number) {
  if (checkedCount === totalCount && totalCount > 0) return 'checked';
  return checkedCount > 0 ? 'indeterminate' : 'unchecked';
}

interface ChangesFilesPanelProps {
  // Header
  summaries: FileDiffSummary[];
  filteredDiffs: FileDiffSummary[];
  checkedCount: number;
  totalCount: number;
  toggleAll: () => void;
  hasFolders: boolean;
  allFoldersCollapsed: boolean;
  collapsedFolders: Set<string>;
  handleCollapseAllFolders: () => void;
  handleExpandAllFolders: () => void;

  // List state
  loading: boolean;
  loadError: boolean;
  loadErrorMessage: string | null;
  refresh: () => void;
  fileSearch: string;
  treeRows: TreeRow[];

  // File interaction
  selectedFile: string | null;
  setSelectedFile: (path: string | null) => void;
  expandedFile: string | null;
  setExpandedFile: (path: string | null) => void;
  loadDiffForFile: (path: string) => Promise<void>;
  checkedFiles: Set<string>;
  toggleFile: (path: string) => void;
  toggleFolder: (path: string) => void;
  toggleSubmodule: (submodulePath: string) => void;
  expandedSubmodules: Set<string>;

  // Per-file line-selection state
  fileSelectionState: Map<string, 'all' | 'partial' | 'none'>;
  setFileSelectionState: Dispatch<SetStateAction<Map<string, 'all' | 'partial' | 'none'>>>;
  setSelectAllSignal: Dispatch<SetStateAction<number>>;
  setDeselectAllSignal: Dispatch<SetStateAction<number>>;

  // Per-file actions
  handleStageFile: (path: string) => void;
  handleUnstageFile: (path: string) => void;
  handleRevertFile: (path: string) => void;
  handleDiscardFolder: (folderPath: string) => void;
  handleIgnore: (pattern: string) => void;
  handleCopyPath: (path: string, relative: boolean) => void;
  handleOpenDirectory: (path: string, isFile: boolean) => void;

  basePath: string | undefined;
  /** A steer sharee viewing read-only (thread-sharing-steer): per-row git write
   *  actions (stage/unstage/revert/discard/ignore) are owner-only, so they're
   *  hidden. Read-only items (open, copy path) stay. */
  readOnly?: boolean;
}

type FileListProps = ChangesFilesPanelProps & {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** Timestamp of the last row-menu close (see MENU_CLOSE_CLICK_GUARD_MS). */
  dropdownCloseRef: RefObject<number>;
};

/**
 * Select-all header + virtualized list of files in the Changes tab. Each row
 * is a folder, a file, or a submodule status placeholder. Each file row has
 * a tri-state checkbox tied to line-level patch selection and a per-row
 * dropdown for editor-open / stage / unstage / revert / ignore / copy-path.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md. Row renderers live in
 * `ChangesFolderRow`, `ChangesFileRow` and `ChangesRowParts`.
 */
export function ChangesFilesPanel(props: ChangesFilesPanelProps) {
  const { treeRows } = props;
  const fileListRef = useRef<HTMLDivElement>(null);
  const dropdownCloseRef = useRef(0);

  const virtualizer = useVirtualizer({
    count: treeRows.length,
    getScrollElement: () => fileListRef.current,
    estimateSize: (index) =>
      treeRows[index]?.kind === 'folder' ? FOLDER_ROW_HEIGHT : FILE_ROW_HEIGHT,
    getItemKey: (index) => treeRowKey(treeRows[index]),
    overscan: 15,
  });

  return (
    <>
      {/* Select all / count */}
      {props.summaries.length > 0 && <SelectAllHeader {...props} />}

      {/* File list (virtualized) — wrapper ensures flex-1 so commit area stays pinned to bottom */}
      <div ref={fileListRef} className="min-h-0 flex-1 overflow-auto">
        <FileListContent {...props} virtualizer={virtualizer} dropdownCloseRef={dropdownCloseRef} />
      </div>
    </>
  );
}

function SelectAllHeader({
  checkedCount,
  totalCount,
  toggleAll,
  hasFolders,
  allFoldersCollapsed,
  collapsedFolders,
  handleCollapseAllFolders,
  handleExpandAllFolders,
}: ChangesFilesPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="border-sidebar-border flex h-8 items-center gap-1.5 border-b py-1.5 pr-2 pl-2">
      <TriCheckbox
        state={selectAllState(checkedCount, totalCount)}
        onToggle={toggleAll}
        aria-label={t('review.selectAll', 'Select all files')}
        data-testid="review-select-all"
      />
      <span className="text-muted-foreground text-xs">
        {checkedCount}/{totalCount} {t('review.selected', 'selected')}
      </span>
      {hasFolders && (
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleCollapseAllFolders}
                disabled={allFoldersCollapsed}
                data-testid="review-collapse-all"
                className="text-muted-foreground"
              >
                <FolderMinus className="icon-xs" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t('common.collapseAll', 'Collapse all folders')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleExpandAllFolders}
                disabled={collapsedFolders.size === 0}
                data-testid="review-expand-all"
                className="text-muted-foreground"
              >
                <FolderOpen className="icon-xs" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t('common.expandAll', 'Expand all folders')}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

type FileListStatus = 'loading' | 'error' | 'no-changes' | 'no-matches' | 'rows';

function fileListStatus({
  loading,
  loadError,
  summaries,
  filteredDiffs,
}: Pick<
  ChangesFilesPanelProps,
  'loading' | 'loadError' | 'summaries' | 'filteredDiffs'
>): FileListStatus {
  if (loading && summaries.length === 0) return 'loading';
  if (loadError) return 'error';
  if (summaries.length === 0 && !loading) return 'no-changes';
  if (filteredDiffs.length === 0 && !loading) return 'no-matches';
  return 'rows';
}

function FileListContent(props: FileListProps) {
  const { t } = useTranslation();
  switch (fileListStatus(props)) {
    case 'loading':
      return (
        <LoadingState
          testId="review-changes-loading"
          label={t('review.loading', 'Loading changes…')}
        />
      );
    case 'error':
      return (
        <EmptyState
          testId="review-load-error"
          icon={AlertTriangle}
          title={t('review.loadFailed', 'Failed to load changes')}
          description={props.loadErrorMessage}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={props.refresh}
              className="gap-1.5"
              data-testid="review-retry"
            >
              <RotateCcw className="icon-xs" />
              {t('common.retry', 'Retry')}
            </Button>
          }
        />
      );
    case 'no-changes':
      return <EmptyState icon={FileCheck2} title={t('review.noChanges')} />;
    case 'no-matches':
      return <EmptyState icon={Search} title={t('review.noMatchingFiles', 'No matching files')} />;
    default:
      return <VirtualizedRows {...props} />;
  }
}

function VirtualizedRows({
  virtualizer,
  dropdownCloseRef,
  treeRows,
  loading,
  collapsedFolders,
  fileSearch,
  basePath,
  readOnly,
  toggleFolder,
  handleOpenDirectory,
  handleDiscardFolder,
  handleIgnore,
  setSelectedFile,
  setExpandedFile,
  loadDiffForFile,
  ...rest
}: FileListProps) {
  const onMenuClosed = () => {
    dropdownCloseRef.current = Date.now();
  };

  const fileCtx: ChangesFileRowContext = {
    ...rest,
    fileSearch,
    basePath,
    readOnly,
    handleIgnore,
    handleOpenDirectory,
    onMenuClosed,
    openFileDiff: (path) => {
      if (Date.now() - dropdownCloseRef.current < MENU_CLOSE_CLICK_GUARD_MS) return;
      setSelectedFile(path);
      setExpandedFile(path);
      // Kick off the diff fetch synchronously so loadingDiff is
      // set in the same render batch — avoids a flash of
      // "No diff available" before the useEffect-on-expandedFile
      // fires the request.
      loadDiffForFile(path);
    },
  };

  return (
    <div className={cn(loading && 'pointer-events-none')}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = treeRows[virtualRow.index];
          if (row.kind === 'submodule-status') {
            return (
              <SubmoduleStatusRowView
                key={`submodule-status-${row.submodulePath}-${row.state}`}
                row={row}
                position={virtualRow}
              />
            );
          }
          if (row.kind === 'folder') {
            return (
              <ChangesFolderRow
                key={`folder-${row.path}`}
                row={row}
                position={virtualRow}
                isCollapsed={collapsedFolders.has(row.path)}
                fileSearch={fileSearch}
                basePath={basePath}
                readOnly={readOnly}
                toggleFolder={toggleFolder}
                handleOpenDirectory={handleOpenDirectory}
                handleDiscardFolder={handleDiscardFolder}
                handleIgnore={handleIgnore}
                onMenuClosed={onMenuClosed}
              />
            );
          }
          return (
            <ChangesFileRow
              key={row.file.path}
              file={row.file}
              depth={row.depth}
              position={virtualRow}
              ctx={fileCtx}
            />
          );
        })}
      </div>
    </div>
  );
}
