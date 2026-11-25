import { ChevronRight, FolderIcon, FolderOpen, FolderOpenDot } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { HostDropdownMenuItem } from '@/components/HostOnly';
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { HighlightText } from '@/components/ui/highlight-text';
import { setFileMentionDragData } from '@/lib/file-mention-dnd';
import type { TreeRow } from '@/lib/file-tree';
import { cn } from '@/lib/utils';

import { DiffStats } from '../DiffStats';
import { INDENT_PX, type FileTreeRowCommon } from './row-props';
import { CopyPathItems, RowMenu } from './RowMenu';

interface FileTreeFolderRowProps {
  row: Extract<TreeRow, { kind: 'folder' }>;
  common: FileTreeRowCommon;
  isCollapsed: boolean;
  onToggleFolder: (folderPath: string) => void;
}

export function FileTreeFolderRow({
  row,
  common: {
    fontSize,
    hoverClass,
    testIdPrefix,
    searchQuery,
    hideDiffStats,
    hideStatus,
    diffStatsSize,
    basePath,
    dropdownCloseRef,
    onCopyPath,
    onOpenDirectory,
  },
  isCollapsed,
  onToggleFolder,
}: FileTreeFolderRowProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'group flex h-[24px] cursor-pointer select-none items-center gap-1.5 overflow-hidden pr-1 pl-[var(--file-tree-indent)]',
        fontSize,
        'text-muted-foreground transition-colors',
        hoverClass,
      )}
      style={{ '--file-tree-indent': `${8 + row.depth * INDENT_PX}px` }}
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
        onClick={() => onToggleFolder(row.path)}
        aria-expanded={!isCollapsed}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <ChevronRight
          className={cn('icon-sm shrink-0 transition-transform', !isCollapsed && 'rotate-90')}
        />
        {isCollapsed ? (
          <FolderIcon className="icon-base text-muted-foreground/70 shrink-0" />
        ) : (
          <FolderOpen className="icon-base text-muted-foreground/70 shrink-0" />
        )}
        {searchQuery ? (
          <HighlightText
            text={row.label}
            query={searchQuery}
            className={cn(
              'min-w-0 flex-1 truncate font-mono-explorer',
              // oxlint-disable-next-line shadcn/require-static-classes -- fontSize is a Tailwind class prop
              fontSize,
            )}
          />
        ) : (
          <span className={cn('min-w-0 flex-1 truncate font-mono-explorer', fontSize)}>
            {row.label}
          </span>
        )}
        {!hideDiffStats && (
          <DiffStats linesAdded={row.additions} linesDeleted={row.deletions} size={diffStatsSize} />
        )}
        {!hideStatus && <span className={cn('invisible shrink-0 font-medium', fontSize)}>M</span>}
      </button>
      {basePath ? (
        <RowMenu
          triggerTestId={`${testIdPrefix}-folder-menu-${row.path}`}
          dropdownCloseRef={dropdownCloseRef}
        >
          <HostDropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              void onOpenDirectory(row.path, false);
            }}
            data-testid={`${testIdPrefix}-folder-open-directory-${row.path}`}
          >
            <FolderOpenDot />
            {t('sidebar.openDirectory')}
          </HostDropdownMenuItem>
          <DropdownMenuSeparator />
          <CopyPathItems path={row.path} onCopyPath={onCopyPath} />
        </RowMenu>
      ) : (
        <span className="size-6 shrink-0" />
      )}
    </div>
  );
}
