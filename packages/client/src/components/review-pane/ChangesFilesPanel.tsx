import type { FileDiffSummary } from '@funny/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ChevronRight,
  ClipboardCopy,
  Copy,
  ExternalLink,
  EyeOff,
  FileCheck2,
  FileCode,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderOpenDot,
  FolderX,
  GitBranch,
  MoreHorizontal,
  RotateCcw,
  Search,
  Undo2,
} from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { TreeRow } from '@/components/FileTree';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { HighlightText } from '@/components/ui/highlight-text';
import { LoadingState } from '@/components/ui/loading-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TriCheckbox } from '@/components/ui/tri-checkbox';
import {
  getEditorLabel,
  openFileInExternalEditor,
  openFileInInternalEditor,
} from '@/lib/editor-utils';
import { FileExtensionIcon } from '@/lib/file-icons';
import { setFileMentionDragData } from '@/lib/file-mention-dnd';
import { cn } from '@/lib/utils';

import { DiffStats } from '../DiffStats';

const FILE_ROW_HEIGHT = 24;
const FOLDER_ROW_HEIGHT = 24;
const INDENT_PX = 12;

function getParentFolders(filePath: string): string[] {
  const parts = filePath.split('/');
  const folders: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    folders.push('/' + parts.slice(0, i).join('/'));
  }
  return folders;
}

function getFileExtension(filePath: string): string | null {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filePath.length - 1) return null;
  return filePath.substring(lastDot);
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
}

/**
 * Select-all header + virtualized list of files in the Changes tab. Each row
 * is a folder, a file, or a submodule status placeholder. Each file row has
 * a tri-state checkbox tied to line-level patch selection and a per-row
 * dropdown for editor-open / stage / unstage / revert / ignore / copy-path.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function ChangesFilesPanel({
  summaries,
  filteredDiffs,
  checkedCount,
  totalCount,
  toggleAll,
  hasFolders,
  allFoldersCollapsed,
  collapsedFolders,
  handleCollapseAllFolders,
  handleExpandAllFolders,
  loading,
  loadError,
  refresh,
  fileSearch,
  treeRows,
  selectedFile,
  setSelectedFile,
  expandedFile,
  setExpandedFile,
  loadDiffForFile,
  checkedFiles,
  toggleFile,
  toggleFolder,
  toggleSubmodule,
  expandedSubmodules,
  fileSelectionState,
  setFileSelectionState,
  setSelectAllSignal,
  setDeselectAllSignal,
  handleStageFile,
  handleUnstageFile,
  handleRevertFile,
  handleDiscardFolder,
  handleIgnore,
  handleCopyPath,
  handleOpenDirectory,
  basePath,
}: ChangesFilesPanelProps) {
  const { t } = useTranslation();
  const fileListRef = useRef<HTMLDivElement>(null);
  const dropdownCloseRef = useRef(0);

  const virtualizer = useVirtualizer({
    count: treeRows.length,
    getScrollElement: () => fileListRef.current,
    estimateSize: (index) =>
      treeRows[index]?.kind === 'folder' ? FOLDER_ROW_HEIGHT : FILE_ROW_HEIGHT,
    getItemKey: (index) => {
      const row = treeRows[index];
      if (row.kind === 'folder') return `d:${row.path}`;
      if (row.kind === 'submodule-status') return `s:${row.submodulePath}:${row.state}`;
      return `f:${row.file.path}`;
    },
    overscan: 15,
  });

  return (
    <>
      {/* Select all / count */}
      {summaries.length > 0 && (
        <div className="border-sidebar-border flex h-8 items-center gap-1.5 border-b py-1.5 pr-2 pl-2">
          <TriCheckbox
            state={
              checkedCount === totalCount && totalCount > 0
                ? 'checked'
                : checkedCount > 0
                  ? 'indeterminate'
                  : 'unchecked'
            }
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
      )}

      {/* File list (virtualized) — wrapper ensures flex-1 so commit area stays pinned to bottom */}
      <div ref={fileListRef} className="min-h-0 flex-1 overflow-auto">
        {loading && summaries.length === 0 ? (
          <LoadingState
            testId="review-changes-loading"
            label={t('review.loading', 'Loading changes…')}
          />
        ) : loadError ? (
          <EmptyState
            testId="review-load-error"
            icon={AlertTriangle}
            title={t('review.loadFailed', 'Failed to load changes')}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={refresh}
                className="gap-1.5"
                data-testid="review-retry"
              >
                <RotateCcw className="icon-xs" />
                {t('common.retry', 'Retry')}
              </Button>
            }
          />
        ) : summaries.length === 0 && !loading ? (
          <EmptyState icon={FileCheck2} title={t('review.noChanges')} />
        ) : filteredDiffs.length === 0 && !loading ? (
          <EmptyState icon={Search} title={t('review.noMatchingFiles', 'No matching files')} />
        ) : (
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
                const paddingLeft = `${8 + row.depth * INDENT_PX}px`;

                if (row.kind === 'submodule-status') {
                  const label =
                    row.state === 'loading'
                      ? t('review.submoduleLoading', { defaultValue: 'Loading submodule files…' })
                      : row.state === 'error'
                        ? (row.message ??
                          t('review.submoduleError', { defaultValue: 'Failed to load submodule' }))
                        : t('review.submoduleEmpty', {
                            defaultValue: 'No changes inside submodule',
                          });
                  return (
                    <div
                      key={`submodule-status-${row.submodulePath}-${row.state}`}
                      className="text-muted-foreground/80 flex items-center gap-1.5 text-xs italic"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                        paddingLeft,
                      }}
                      data-testid={`review-submodule-status-${row.submodulePath}`}
                    >
                      <span className="truncate">{label}</span>
                    </div>
                  );
                }

                if (row.kind === 'folder') {
                  const isCollapsed = collapsedFolders.has(row.path);
                  return (
                    <div
                      key={`folder-${row.path}`}
                      className="group text-muted-foreground hover:bg-sidebar-accent/50 flex cursor-pointer items-center gap-1.5 text-xs select-none"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                        paddingLeft,
                      }}
                      onClick={() => toggleFolder(row.path)}
                      draggable
                      onDragStart={(e) => {
                        setFileMentionDragData(e.dataTransfer, {
                          path: row.path,
                          fileType: 'folder',
                        });
                      }}
                      data-testid={`review-folder-${row.path}`}
                    >
                      <ChevronRight
                        className={cn(
                          'icon-sm shrink-0 transition-transform',
                          !isCollapsed && 'rotate-90',
                        )}
                      />
                      {isCollapsed ? (
                        <Folder className="icon-base text-muted-foreground/70 shrink-0" />
                      ) : (
                        <FolderOpen className="icon-base text-muted-foreground/70 shrink-0" />
                      )}
                      <HighlightText
                        text={row.label}
                        query={fileSearch}
                        className="font-mono-explorer flex-1 truncate text-xs"
                      />
                      <DiffStats
                        linesAdded={row.additions}
                        linesDeleted={row.deletions}
                        size="xs"
                      />
                      {/* Spacer to align with file rows' status letter */}
                      <span className="invisible shrink-0 text-xs font-medium">M</span>
                      <DropdownMenu
                        onOpenChange={(open) => {
                          if (!open) dropdownCloseRef.current = Date.now();
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          <button
                            onClick={(e) => e.stopPropagation()}
                            onPointerDown={(e) => e.stopPropagation()}
                            aria-label={t('review.moreActions', 'More actions')}
                            className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-all group-hover:opacity-100 data-[state=open]:opacity-100"
                            data-testid={`review-folder-menu-${row.path}`}
                          >
                            <MoreHorizontal className="icon-sm" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="min-w-[220px]"
                          onCloseAutoFocus={(e) => e.preventDefault()}
                        >
                          {basePath && (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleOpenDirectory(row.path, false);
                              }}
                              data-testid={`review-folder-open-directory-${row.path}`}
                            >
                              <FolderOpenDot />
                              {t('sidebar.openDirectory')}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDiscardFolder(row.path);
                            }}
                            className="text-destructive focus:text-destructive"
                            data-testid={`review-folder-discard-${row.path}`}
                          >
                            <Undo2 />
                            {t('review.discardFolder')}
                          </DropdownMenuItem>
                          {(() => {
                            const folderOptions = ['/' + row.path, ...getParentFolders(row.path)];
                            if (folderOptions.length === 1) {
                              return (
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleIgnore(folderOptions[0]);
                                  }}
                                  data-testid={`review-folder-ignore-${row.path}`}
                                >
                                  <FolderX />
                                  {t('review.ignoreFolder')}
                                </DropdownMenuItem>
                              );
                            }
                            return (
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger
                                  onClick={(e) => e.stopPropagation()}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  data-testid={`review-folder-ignore-${row.path}`}
                                >
                                  <FolderX />
                                  {t('review.ignoreFolder')}
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent
                                  onClick={(e) => e.stopPropagation()}
                                  onPointerDown={(e) => e.stopPropagation()}
                                >
                                  {folderOptions.map((folder) => (
                                    <DropdownMenuItem
                                      key={folder}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleIgnore(folder);
                                      }}
                                      data-testid={`review-folder-ignore-${row.path}-option-${folder}`}
                                    >
                                      {folder}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                            );
                          })()}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                }

                const f = row.file;
                const isChecked = checkedFiles.has(f.path);
                const lineSelState = fileSelectionState.get(f.path);
                const isPartial = isChecked && lineSelState === 'partial';
                return (
                  <div
                    key={f.path}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                      paddingLeft,
                    }}
                    className={cn(
                      'group flex items-center gap-1.5 text-xs cursor-pointer',
                      selectedFile === f.path
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'hover:bg-sidebar-accent/50 text-muted-foreground',
                    )}
                    onClick={() => {
                      if (Date.now() - dropdownCloseRef.current < 400) return;
                      setSelectedFile(f.path);
                      setExpandedFile(f.path);
                      // Kick off the diff fetch synchronously so loadingDiff is
                      // set in the same render batch — avoids a flash of
                      // "No diff available" before the useEffect-on-expandedFile
                      // fires the request.
                      loadDiffForFile(f.path);
                    }}
                    draggable
                    onDragStart={(e) => {
                      setFileMentionDragData(e.dataTransfer, {
                        path: f.path,
                        fileType: 'file',
                      });
                    }}
                  >
                    <TriCheckbox
                      state={isPartial ? 'indeterminate' : isChecked ? 'checked' : 'unchecked'}
                      onToggle={(e) => {
                        e.stopPropagation();
                        // If partial or unchecked → check and re-select all lines
                        if (isPartial || !isChecked) {
                          if (!isChecked) toggleFile(f.path);
                          // Signal ExpandedDiffView to re-select all lines
                          if (expandedFile === f.path) {
                            setSelectAllSignal((s) => s + 1);
                          }
                          // Clear the partial state immediately
                          setFileSelectionState((prev) => {
                            const next = new Map(prev);
                            next.set(f.path, 'all');
                            return next;
                          });
                        } else {
                          toggleFile(f.path);
                          // Signal ExpandedDiffView to deselect all lines
                          if (expandedFile === f.path) {
                            setDeselectAllSignal((s) => s + 1);
                          }
                          setFileSelectionState((prev) => {
                            const next = new Map(prev);
                            next.set(f.path, 'none');
                            return next;
                          });
                        }
                      }}
                      aria-label={t('review.selectFile', {
                        file: f.path,
                        defaultValue: `Select ${f.path}`,
                      })}
                      data-testid={`review-file-checkbox-${f.path}`}
                    />
                    {f.kind === 'submodule' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSubmodule(f.path);
                        }}
                        aria-label={
                          expandedSubmodules.has(f.path)
                            ? t('review.collapseSubmodule', { defaultValue: 'Collapse submodule' })
                            : t('review.expandSubmodule', { defaultValue: 'Expand submodule' })
                        }
                        className="text-muted-foreground hover:text-foreground flex size-4 shrink-0 items-center justify-center rounded"
                        data-testid={`review-submodule-toggle-${f.path}`}
                      >
                        <ChevronRight
                          className={cn(
                            'icon-sm transition-transform',
                            expandedSubmodules.has(f.path) && 'rotate-90',
                          )}
                        />
                      </button>
                    )}
                    {f.kind === 'submodule' ? (
                      <GitBranch
                        className="icon-base shrink-0 text-purple-500 dark:text-purple-400"
                        data-testid={`review-submodule-icon-${f.path}`}
                      />
                    ) : (
                      <FileExtensionIcon
                        filePath={f.path}
                        className="icon-base text-muted-foreground/80 shrink-0"
                      />
                    )}
                    <HighlightText
                      text={f.path.split('/').pop() || f.path}
                      query={fileSearch}
                      className="font-mono-explorer flex-1 truncate text-xs"
                    />
                    {f.kind === 'submodule' && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="shrink-0 rounded-sm border border-purple-500/40 bg-purple-500/10 px-1 text-[10px] tracking-wide text-purple-600 uppercase dark:text-purple-300"
                            data-testid={`review-submodule-badge-${f.path}`}
                          >
                            {f.nestedDirty && f.nestedDirty.dirtyFileCount > 0
                              ? t('review.submoduleDirtyCount', {
                                  count: f.nestedDirty.dirtyFileCount,
                                  defaultValue: 'submodule · {{count}}',
                                })
                              : t('review.submodule', { defaultValue: 'submodule' })}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs">
                          <div className="font-medium">
                            {t('review.submoduleTooltip', {
                              defaultValue: 'Nested git repository (gitlink)',
                            })}
                          </div>
                          {f.nestedDirty && (
                            <div className="mt-1 space-y-0.5 font-mono">
                              {f.nestedDirty.pointerMoved && (
                                <div>
                                  {t('review.submodulePointerMoved', {
                                    defaultValue: 'Gitlink pointer moved (parent-visible change).',
                                  })}
                                </div>
                              )}
                              <div>
                                {t('review.submoduleDirtyLine', {
                                  count: f.nestedDirty.dirtyFileCount,
                                  defaultValue: '{{count}} file(s) dirty inside',
                                })}
                              </div>
                              {(f.nestedDirty.linesAdded > 0 || f.nestedDirty.linesDeleted > 0) && (
                                <div>
                                  <span className="text-diff-added">
                                    +{f.nestedDirty.linesAdded}
                                  </span>{' '}
                                  <span className="text-diff-removed">
                                    -{f.nestedDirty.linesDeleted}
                                  </span>{' '}
                                  <span className="text-muted-foreground">
                                    {t('review.submoduleLines', { defaultValue: 'lines' })}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                          <div className="text-muted-foreground mt-1">
                            {t('review.submoduleExpandHint', {
                              defaultValue: 'Click the arrow to expand inner files.',
                            })}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <DiffStats
                      linesAdded={
                        f.kind === 'submodule' && f.nestedDirty
                          ? f.nestedDirty.linesAdded
                          : (f.additions ?? 0)
                      }
                      linesDeleted={
                        f.kind === 'submodule' && f.nestedDirty
                          ? f.nestedDirty.linesDeleted
                          : (f.deletions ?? 0)
                      }
                      size="xs"
                    />
                    <span
                      className="shrink-0 text-xs font-medium"
                      style={{
                        color:
                          f.status === 'conflicted'
                            ? 'hsl(0 72% 51%)'
                            : f.status === 'added'
                              ? 'hsl(142 40% 45%)'
                              : f.status === 'modified'
                                ? 'hsl(30 90% 55%)'
                                : f.status === 'deleted'
                                  ? 'hsl(0 45% 55%)'
                                  : 'hsl(200 80% 60%)',
                      }}
                    >
                      {f.status === 'conflicted'
                        ? 'C'
                        : f.status === 'added'
                          ? 'A'
                          : f.status === 'modified'
                            ? 'M'
                            : f.status === 'deleted'
                              ? 'D'
                              : 'R'}
                    </span>
                    <DropdownMenu
                      onOpenChange={(open) => {
                        if (!open) dropdownCloseRef.current = Date.now();
                      }}
                    >
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                          }}
                          aria-label={t('review.moreActions', 'More actions')}
                          className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-all group-hover:opacity-100 data-[state=open]:opacity-100"
                        >
                          <MoreHorizontal className="icon-sm" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="min-w-[220px]"
                        onCloseAutoFocus={(e) => e.preventDefault()}
                      >
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            const fullPath = basePath ? `${basePath}/${f.path}` : f.path;
                            openFileInExternalEditor(fullPath);
                          }}
                        >
                          <ExternalLink />
                          {t('review.openInEditor', { editor: getEditorLabel() })}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            const fullPath = basePath ? `${basePath}/${f.path}` : f.path;
                            openFileInInternalEditor(fullPath);
                          }}
                          data-testid={`review-open-internal-editor-${f.path}`}
                        >
                          <FileCode />
                          {t('review.openInInternalEditor')}
                        </DropdownMenuItem>
                        {basePath && (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleOpenDirectory(f.path, true);
                            }}
                            data-testid={`review-file-open-directory-${f.path}`}
                          >
                            <FolderOpenDot />
                            {t('sidebar.openDirectory')}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        {f.staged ? (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUnstageFile(f.path);
                            }}
                            data-testid={`review-unstage-file-${f.path}`}
                          >
                            <ArchiveRestore />
                            {t('review.unstageFile', { defaultValue: 'Unstage file' })}
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStageFile(f.path);
                            }}
                            data-testid={`review-stage-file-${f.path}`}
                          >
                            <Archive />
                            {t('review.stageFile', { defaultValue: 'Stage file' })}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRevertFile(f.path);
                          }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Undo2 />
                          {t('review.discardChanges')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleIgnore(f.path);
                          }}
                        >
                          <EyeOff />
                          {t('review.ignoreFile')}
                        </DropdownMenuItem>
                        {(() => {
                          const folders = getParentFolders(f.path);
                          if (folders.length === 0) return null;
                          if (folders.length === 1) {
                            return (
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleIgnore(folders[0]);
                                }}
                              >
                                <FolderX />
                                {t('review.ignoreFolder')}
                              </DropdownMenuItem>
                            );
                          }
                          return (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger
                                onClick={(e) => e.stopPropagation()}
                                onPointerDown={(e) => e.stopPropagation()}
                              >
                                <FolderX />
                                {t('review.ignoreFolder')}
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent
                                onClick={(e) => e.stopPropagation()}
                                onPointerDown={(e) => e.stopPropagation()}
                              >
                                {folders.map((folder) => (
                                  <DropdownMenuItem
                                    key={folder}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleIgnore(folder);
                                    }}
                                  >
                                    {folder}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          );
                        })()}
                        {(() => {
                          const ext = getFileExtension(f.path);
                          if (!ext) return null;
                          return (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleIgnore(`*${ext}`);
                              }}
                            >
                              <EyeOff />
                              {t('review.ignoreExtension', { ext })}
                            </DropdownMenuItem>
                          );
                        })()}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyPath(f.path, false);
                          }}
                        >
                          <Copy />
                          {t('review.copyFilePath')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyPath(f.path, true);
                          }}
                        >
                          <ClipboardCopy />
                          {t('review.copyRelativePath')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
