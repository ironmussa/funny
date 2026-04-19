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
import {
  openFileInExternalEditor,
  openFileInInternalEditor,
  getEditorLabel,
} from '@/lib/editor-utils';
import { FileExtensionIcon } from '@/lib/file-icons';
import { cn } from '@/lib/utils';

import { DiffStats } from './DiffStats';

/* ── Tree data structures ── */

const INDENT_PX = 12;
const ROW_HEIGHT = 24; // h-6 = 1.5rem = 24px

export type TreeRow =
  | {
      kind: 'folder';
      path: string;
      label: string;
      depth: number;
      fileCount: number;
      additions: number;
      deletions: number;
    }
  | { kind: 'file'; file: FileDiffSummary; depth: number };

interface FolderNode {
  children: Map<string, FolderNode>;
  files: FileDiffSummary[];
}

export function buildTreeRows(diffs: FileDiffSummary[], collapsed: Set<string>): TreeRow[] {
  const root: FolderNode = { children: new Map(), files: [] };
  for (const f of diffs) {
    const parts = f.path.split('/');
    parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { children: new Map(), files: [] });
      }
      node = node.children.get(part)!;
    }
    node.files.push(f);
  }

  function aggregateStats(node: FolderNode) {
    let fileCount = node.files.length;
    let additions = node.files.reduce((acc, f) => acc + (f.additions ?? 0), 0);
    let deletions = node.files.reduce((acc, f) => acc + (f.deletions ?? 0), 0);
    for (const child of node.children.values()) {
      const s = aggregateStats(child);
      fileCount += s.fileCount;
      additions += s.additions;
      deletions += s.deletions;
    }
    return { fileCount, additions, deletions };
  }

  const rows: TreeRow[] = [];

  function flatten(node: FolderNode, depth: number, pathPrefix: string) {
    const sortedFolders = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [name, child] of sortedFolders) {
      let compactedName = name;
      let current = child;
      let currentPath = pathPrefix ? `${pathPrefix}/${name}` : name;
      while (current.files.length === 0 && current.children.size === 1) {
        const [nextName, nextChild] = [...current.children.entries()][0];
        compactedName += `/${nextName}`;
        currentPath += `/${nextName}`;
        current = nextChild;
      }
      const folderPath = currentPath;
      const stats = aggregateStats(current);
      rows.push({
        kind: 'folder',
        path: folderPath,
        label: compactedName,
        depth,
        fileCount: stats.fileCount,
        additions: stats.additions,
        deletions: stats.deletions,
      });
      if (!collapsed.has(folderPath)) {
        flatten(current, depth + 1, currentPath);
      }
    }
    for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: 'file', file, depth });
    }
  }

  flatten(root, 0, '');
  return rows;
}

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
}: FileTreeProps) {
  const { t } = useTranslation();
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const dropdownCloseRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const treeRows = useMemo(() => buildTreeRows(files, collapsedFolders), [files, collapsedFolders]);

  const virtualizer = useVirtualizer({
    count: virtualize ? treeRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => {
      const row = treeRows[index];
      return row.kind === 'folder' ? `d:${row.path}` : `f:${row.file.path}`;
    },
    overscan: 15,
    enabled: virtualize,
  });

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const handleCopyPath = useCallback(
    (path: string, relative: boolean) => {
      const text = relative ? path : `/${path}`;
      navigator.clipboard.writeText(text);
      toast.success(t('review.pathCopied'));
    },
    [t],
  );

  const renderRow = (row: TreeRow, index: number, style?: CSSProperties) => {
    if (row.kind === 'folder') {
      const isCollapsed = collapsedFolders.has(row.path);
      return (
        <div
          key={`folder-${row.path}`}
          className={cn(
            'flex h-6 cursor-pointer select-none items-center gap-1.5 overflow-hidden pr-1',
            fontSize,
            'text-muted-foreground transition-colors',
            hoverClass,
          )}
          style={{
            ...style,
            paddingLeft: `${8 + row.depth * INDENT_PX}px`,
          }}
          onClick={() => toggleFolder(row.path)}
          data-testid={`${testIdPrefix}-folder-${row.path}`}
        >
          <ChevronRight
            className={cn(
              'icon-sm flex-shrink-0 transition-transform',
              !isCollapsed && 'rotate-90',
            )}
          />
          {isCollapsed ? (
            <Folder className="icon-base flex-shrink-0 text-muted-foreground/70" />
          ) : (
            <FolderOpen className="icon-base flex-shrink-0 text-muted-foreground/70" />
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
          <DiffStats linesAdded={row.additions} linesDeleted={row.deletions} size={diffStatsSize} />
          {/* Spacers to align with file rows (status letter + 3-dot menu) */}
          <span className={cn('invisible flex-shrink-0 font-medium', fontSize)}>M</span>
          <span className="h-6 w-6 flex-shrink-0" />
        </div>
      );
    }

    const f = row.file;
    const isActive = f.path === selectedFile;
    const isChecked = checkedFiles?.has(f.path) ?? false;
    const fileName = f.path.split('/').pop() || f.path;
    const isSubmodule = f.kind === 'submodule';

    return (
      <div
        key={f.path}
        className={cn(
          'group flex h-6 items-center gap-1.5 cursor-pointer transition-colors overflow-hidden pr-1',
          fontSize,
          isActive ? activeClass : hoverClass,
        )}
        style={{
          ...style,
          paddingLeft: `${8 + row.depth * INDENT_PX}px`,
        }}
        onClick={() => {
          if (Date.now() - dropdownCloseRef.current < 400) return;
          onFileClick(f.path);
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
              'flex items-center justify-center h-3.5 w-3.5 rounded border transition-colors flex-shrink-0',
              isChecked
                ? 'bg-primary border-primary text-primary-foreground'
                : 'border-muted-foreground/40',
            )}
            data-testid={`${testIdPrefix}-check-${f.path}`}
          >
            {isChecked && <Check className="icon-2xs" />}
          </button>
        )}
        {isSubmodule ? (
          <GitBranch
            className="h-4 w-4 flex-shrink-0 text-purple-500 dark:text-purple-400"
            data-testid={`${testIdPrefix}-submodule-icon-${f.path}`}
          />
        ) : (
          <FileExtensionIcon
            filePath={f.path}
            className="h-4 w-4 flex-shrink-0 text-muted-foreground/80"
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
          <span
            className={cn(
              'flex-shrink-0 rounded-sm border border-purple-500/40 bg-purple-500/10 px-1 text-[10px] uppercase tracking-wide text-purple-600 dark:text-purple-300',
            )}
            title={t('review.submoduleTooltip', {
              defaultValue: 'Nested git repository (gitlink)',
            })}
            data-testid={`${testIdPrefix}-submodule-badge-${f.path}`}
          >
            {t('review.submodule', { defaultValue: 'submodule' })}
          </span>
        )}
        <DiffStats
          linesAdded={f.additions ?? 0}
          linesDeleted={f.deletions ?? 0}
          size={diffStatsSize}
        />
        <span
          className={cn('flex-shrink-0 font-medium', fontSize)}
          style={{ color: statusColor(f.status) }}
        >
          {statusLetter(f.status)}
        </span>
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
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-sidebar-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
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
