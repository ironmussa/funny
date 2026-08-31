import type { FileDiffSummary } from '@funny/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Check,
  ChevronRight,
  ClipboardCopy,
  Copy,
  ExternalLink,
  EyeOff,
  FileCode,
  Folder,
  FolderOpen,
  FolderOpenDot,
  FolderX,
  GitBranch,
  MoreHorizontal,
  Undo2,
} from 'lucide-react';
import { type CSSProperties, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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
import { HighlightText } from '@/components/ui/highlight-text';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { browseApi as api } from '@/lib/api/browse';
import { createClientLogger } from '@/lib/client-logger';
import {
  openFileInExternalEditor,
  openFileInInternalEditor,
  getEditorLabel,
} from '@/lib/editor-utils';
import { FileExtensionIcon } from '@/lib/file-icons';
import { setFileMentionDragData } from '@/lib/file-mention-dnd';
import { buildTreeRows, type TreeRow } from '@/lib/file-tree';
import { cn } from '@/lib/utils';

const log = createClientLogger('file-tree');

import { DiffStats } from './DiffStats';

export type { TreeRow } from '@/lib/file-tree';

const INDENT_PX = 12;
const ROW_HEIGHT = 24; // h-6 = 1.5rem = 24px

/* ── Helpers ── */

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

function statusColor(status: string): string {
  switch (status) {
    case 'added':
      return 'hsl(142 40% 45%)';
    case 'modified':
      return 'hsl(30 90% 55%)';
    case 'deleted':
      return 'hsl(0 45% 55%)';
    default:
      return 'hsl(200 80% 60%)';
  }
}

function statusLetter(status: string): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    default:
      return 'R';
  }
}

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
  /** Optional inline style applied to each row (used for virtualizer positioning) */
  rowStyle?: (row: TreeRow, index: number) => CSSProperties | undefined;
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
  rowStyle,
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

  const renderRow = (row: TreeRow, index: number, style?: CSSProperties) => {
    if (row.kind === 'submodule-status') {
      const label =
        row.state === 'loading'
          ? t('review.submoduleLoading', { defaultValue: 'Loading submodule files…' })
          : row.state === 'error'
            ? (row.message ??
              t('review.submoduleError', { defaultValue: 'Failed to load submodule' }))
            : t('review.submoduleEmpty', { defaultValue: 'No changes inside submodule' });
      return (
        <div
          key={`submodule-status-${row.submodulePath}-${row.state}`}
          className={cn(
            'flex h-[24px] select-none items-center gap-1.5 overflow-hidden pr-1 italic',
            fontSize,
            'text-muted-foreground/80',
          )}
          style={{
            ...style,
            paddingLeft: `${8 + row.depth * INDENT_PX}px`,
          }}
          data-testid={`${testIdPrefix}-submodule-status-${row.submodulePath}`}
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
          className={cn(
            'group flex h-[24px] cursor-pointer select-none items-center gap-1.5 overflow-hidden pr-1',
            fontSize,
            'text-muted-foreground transition-colors',
            hoverClass,
          )}
          style={{
            ...style,
            paddingLeft: `${8 + row.depth * INDENT_PX}px`,
          }}
          draggable
          onDragStart={(e) => {
            setFileMentionDragData(e.dataTransfer, {
              path: row.path,
              fileType: 'folder',
            });
          }}
          data-testid={`${testIdPrefix}-folder-${row.path}`}
        >
          <button
            type="button"
            onClick={() => toggleFolder(row.path)}
            aria-expanded={!isCollapsed}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <ChevronRight
              className={cn('icon-sm shrink-0 transition-transform', !isCollapsed && 'rotate-90')}
            />
            {isCollapsed ? (
              <Folder className="icon-base text-muted-foreground/70 shrink-0" />
            ) : (
              <FolderOpen className="icon-base text-muted-foreground/70 shrink-0" />
            )}
            {searchQuery ? (
              <HighlightText
                text={row.label}
                query={searchQuery}
                className={cn('min-w-0 flex-1 truncate font-mono-explorer', fontSize)}
              />
            ) : (
              <span className={cn('min-w-0 flex-1 truncate font-mono-explorer', fontSize)}>
                {row.label}
              </span>
            )}
            {!hideDiffStats && (
              <DiffStats
                linesAdded={row.additions}
                linesDeleted={row.deletions}
                size={diffStatsSize}
              />
            )}
            {!hideStatus && (
              <span className={cn('invisible shrink-0 font-medium', fontSize)}>M</span>
            )}
          </button>
          {basePath ? (
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
                  className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
                  data-testid={`${testIdPrefix}-folder-menu-${row.path}`}
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
                    void handleOpenDirectory(row.path, false);
                  }}
                  data-testid={`${testIdPrefix}-folder-open-directory-${row.path}`}
                >
                  <FolderOpenDot />
                  {t('sidebar.openDirectory')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCopyPath(row.path, false);
                  }}
                >
                  <Copy />
                  {t('review.copyFilePath')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCopyPath(row.path, true);
                  }}
                >
                  <ClipboardCopy />
                  {t('review.copyRelativePath')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="size-6 shrink-0" />
          )}
        </div>
      );
    }

    const f = row.file;
    const isActive = f.path === selectedFile;
    const isChecked = checkedFiles?.has(f.path) ?? false;
    const fileName = f.path.split('/').pop() || f.path;
    const isSubmodule = f.kind === 'submodule';
    const canExpandSubmodule = isSubmodule && !!onToggleSubmodule;
    const isSubmoduleExpanded = canExpandSubmodule && !!expandedSubmodules?.has(f.path);
    const nested = f.nestedDirty;

    return (
      <div
        key={f.path}
        className={cn(
          'group flex h-[24px] items-center gap-1.5 cursor-pointer transition-colors overflow-hidden pr-1',
          fontSize,
          isActive ? activeClass : hoverClass,
        )}
        style={{
          ...style,
          paddingLeft: `${8 + row.depth * INDENT_PX}px`,
        }}
        draggable
        onDragStart={(e) => {
          setFileMentionDragData(e.dataTransfer, {
            path: f.path,
            fileType: 'file',
          });
        }}
        data-testid={`${testIdPrefix}-file-${f.path}`}
      >
        {checkedFiles && onToggleFile && (
          <button
            role="checkbox"
            aria-checked={isChecked}
            aria-label={t('review.selectFile', {
              file: f.path,
              defaultValue: `Select ${f.path}`,
            })}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFile(f.path);
            }}
            className={cn(
              'flex items-center justify-center size-3.5 rounded border transition-colors shrink-0',
              isChecked
                ? 'bg-primary border-primary text-primary-foreground'
                : 'border-muted-foreground/40',
            )}
            data-testid={`${testIdPrefix}-check-${f.path}`}
          >
            {isChecked && <Check className="icon-2xs" />}
          </button>
        )}
        {canExpandSubmodule && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleSubmodule?.(f.path);
            }}
            aria-label={
              isSubmoduleExpanded
                ? t('review.collapseSubmodule', { defaultValue: 'Collapse submodule' })
                : t('review.expandSubmodule', { defaultValue: 'Expand submodule' })
            }
            className="text-muted-foreground hover:text-foreground flex size-4 shrink-0 items-center justify-center rounded"
            data-testid={`${testIdPrefix}-submodule-toggle-${f.path}`}
          >
            <ChevronRight
              className={cn('icon-sm transition-transform', isSubmoduleExpanded && 'rotate-90')}
            />
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (Date.now() - dropdownCloseRef.current < 400) return;
            onFileClick(f.path);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {isSubmodule ? (
            <GitBranch
              className="size-4 shrink-0 text-purple-500 dark:text-purple-400"
              data-testid={`${testIdPrefix}-submodule-icon-${f.path}`}
            />
          ) : (
            <FileExtensionIcon
              filePath={f.path}
              className="text-muted-foreground/80 size-4 shrink-0"
            />
          )}
          {searchQuery ? (
            <HighlightText
              text={fileName}
              query={searchQuery}
              className={cn('min-w-0 flex-1 truncate font-mono-explorer', fontSize)}
            />
          ) : (
            <span className={cn('min-w-0 flex-1 truncate font-mono-explorer', fontSize)}>
              {fileName}
            </span>
          )}
          {isSubmodule && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'shrink-0 rounded-sm border border-purple-500/40 bg-purple-500/10 px-1 text-[10px] uppercase tracking-wide text-purple-600 dark:text-purple-300',
                  )}
                  data-testid={`${testIdPrefix}-submodule-badge-${f.path}`}
                >
                  {nested && nested.dirtyFileCount > 0
                    ? t('review.submoduleDirtyCount', {
                        count: nested.dirtyFileCount,
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
                {nested && (
                  <div className="mt-1 space-y-0.5 font-mono">
                    {nested.pointerMoved && (
                      <div>
                        {t('review.submodulePointerMoved', {
                          defaultValue: 'Gitlink pointer moved (parent-visible change).',
                        })}
                      </div>
                    )}
                    <div>
                      {t('review.submoduleDirtyLine', {
                        count: nested.dirtyFileCount,
                        defaultValue: '{{count}} file(s) dirty inside',
                      })}
                    </div>
                    {(nested.linesAdded > 0 || nested.linesDeleted > 0) && (
                      <div>
                        <span className="text-diff-added">+{nested.linesAdded}</span>{' '}
                        <span className="text-diff-removed">-{nested.linesDeleted}</span>{' '}
                        <span className="text-muted-foreground">
                          {t('review.submoduleLines', { defaultValue: 'lines' })}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {canExpandSubmodule && (
                  <div className="text-muted-foreground mt-1">
                    {t('review.submoduleExpandHint', {
                      defaultValue: 'Click the arrow to expand inner files.',
                    })}
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          )}
          {!hideDiffStats &&
            (() => {
              const effAdded = isSubmodule && nested ? nested.linesAdded : (f.additions ?? 0);
              const effDeleted = isSubmodule && nested ? nested.linesDeleted : (f.deletions ?? 0);
              return (
                <DiffStats linesAdded={effAdded} linesDeleted={effDeleted} size={diffStatsSize} />
              );
            })()}
          {!hideStatus && (
            <span
              className={cn('shrink-0 font-medium', fontSize)}
              style={{ color: statusColor(f.status) }}
            >
              {statusLetter(f.status)}
            </span>
          )}
        </button>
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
              className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
              data-testid={`${testIdPrefix}-menu-${f.path}`}
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
              data-testid={`file-tree-open-internal-editor-${f.path}`}
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
                data-testid={`${testIdPrefix}-file-open-directory-${f.path}`}
              >
                <FolderOpenDot />
                {t('sidebar.openDirectory')}
              </DropdownMenuItem>
            )}
            {onRevertFile && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onRevertFile(f.path);
                  }}
                  className="text-destructive focus:text-destructive"
                >
                  <Undo2 />
                  {revertLabel ?? t('review.discardChanges')}
                </DropdownMenuItem>
              </>
            )}
            {onIgnore && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onIgnore(f.path);
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
                          onIgnore(folders[0]);
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
                              onIgnore(folder);
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
                        onIgnore(`*${ext}`);
                      }}
                    >
                      <EyeOff />
                      {t('review.ignoreExtension', { ext })}
                    </DropdownMenuItem>
                  );
                })()}
              </>
            )}
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
  };

  /* ── Virtualized rendering ── */

  if (virtualize) {
    return (
      <div ref={scrollRef} style={{ overflow: 'auto', height: '100%' }}>
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = treeRows[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderRow(row, virtualRow.index)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  /* ── Non-virtualized (original) rendering ── */

  return (
    <>
      {treeRows.map((row, index) => {
        const style = rowStyle?.(row, index);
        return renderRow(row, index, style);
      })}
    </>
  );
}
