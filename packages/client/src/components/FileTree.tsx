import type { FileDiffSummary } from '@funny/shared';
import {
  Check,
  ChevronRight,
  ClipboardCopy,
  Copy,
  ExternalLink,
  EyeOff,
  Folder,
  FolderOpen,
  FolderX,
  MoreVertical,
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
import { openFileInEditor, getEditorLabel } from '@/lib/editor-utils';
import { FileExtensionIcon } from '@/lib/file-icons';
import { cn } from '@/lib/utils';

import { DiffStats } from './DiffStats';

/* ── Tree data structures ── */

const INDENT_PX = 12;

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
}

/* ── Component ── */

export function FileTree({
  files,
  selectedFile,
  onFileClick,
  checkedFiles,
  onToggleFile,
  onRevertFile,
  onIgnore,
  basePath,
  diffStatsSize = 'xs',
  fontSize = 'text-xs',
  activeClass = 'bg-sidebar-accent text-sidebar-accent-foreground',
  hoverClass = 'hover:bg-sidebar-accent/50 text-muted-foreground',
  testIdPrefix = 'filetree',
  rowStyle,
}: FileTreeProps) {
  const { t } = useTranslation();
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const dropdownCloseRef = useRef(0);

  const treeRows = useMemo(() => buildTreeRows(files, collapsedFolders), [files, collapsedFolders]);

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

  return (
    <>
      {treeRows.map((row, index) => {
        const style = rowStyle?.(row, index);

        if (row.kind === 'folder') {
          const isCollapsed = collapsedFolders.has(row.path);
          return (
            <div
              key={`folder-${row.path}`}
              className={cn(
                'flex cursor-pointer select-none items-center gap-1.5 py-1',
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
                  'h-3.5 w-3.5 flex-shrink-0 transition-transform',
                  !isCollapsed && 'rotate-90',
                )}
              />
              {isCollapsed ? (
                <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground/70" />
              ) : (
                <FolderOpen className="h-4 w-4 flex-shrink-0 text-muted-foreground/70" />
              )}
              <span className={cn('flex-1 truncate font-mono-explorer', fontSize)}>
                {row.label}
              </span>
              <DiffStats
                linesAdded={row.additions}
                linesDeleted={row.deletions}
                size={diffStatsSize}
              />
              {/* Spacers to align with file rows (status letter + 3-dot menu) */}
              <span className={cn('invisible flex-shrink-0 font-medium', fontSize)}>M</span>
              <span className="h-4 w-4 flex-shrink-0" />
            </div>
          );
        }

        const f = row.file;
        const isActive = f.path === selectedFile;
        const isChecked = checkedFiles?.has(f.path) ?? false;
        const fileName = f.path.split('/').pop() || f.path;

        return (
          <div
            key={f.path}
            className={cn(
              'group flex items-center gap-1.5 py-1 cursor-pointer transition-colors',
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
                {isChecked && <Check className="h-2.5 w-2.5" />}
              </button>
            )}
            <FileExtensionIcon
              filePath={f.path}
              className="h-4 w-4 flex-shrink-0 text-muted-foreground/80"
            />
            <span className={cn('flex-1 truncate font-mono-explorer', fontSize)}>{fileName}</span>
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
                  className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                  data-testid={`${testIdPrefix}-menu-${f.path}`}
                >
                  <MoreVertical className="h-3 w-3" />
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
                    openFileInEditor(fullPath);
                  }}
                >
                  <ExternalLink />
                  {t('review.openInEditor', { editor: getEditorLabel() })}
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
                      {t('review.discardChanges')}
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
      })}
    </>
  );
}
