import { ChevronRight, Folder, FolderOpen, FolderOpenDot, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TreeRow } from '@/components/FileTree';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { HighlightText } from '@/components/ui/highlight-text';
import { setFileMentionDragData } from '@/lib/file-mention-dnd';
import { getParentFolders } from '@/lib/file-tree';
import { cn } from '@/lib/utils';

import { DiffStats } from '../DiffStats';
import {
  IgnoreFolderMenuItems,
  RowActionsMenu,
  stopThen,
  virtualRowStyle,
  type RowPosition,
} from './ChangesRowParts';

type FolderTreeRow = Extract<TreeRow, { kind: 'folder' }>;

interface ChangesFolderRowProps {
  row: FolderTreeRow;
  position: RowPosition;
  isCollapsed: boolean;
  fileSearch: string;
  basePath: string | undefined;
  readOnly?: boolean;
  toggleFolder: (path: string) => void;
  handleOpenDirectory: (path: string, isFile: boolean) => void;
  handleDiscardFolder: (folderPath: string) => void;
  handleIgnore: (pattern: string) => void;
  onMenuClosed: () => void;
}

/** Folder row of the Changes file list: collapse toggle + folder actions menu. */
export function ChangesFolderRow({
  row,
  position,
  isCollapsed,
  fileSearch,
  basePath,
  readOnly,
  toggleFolder,
  handleOpenDirectory,
  handleDiscardFolder,
  handleIgnore,
  onMenuClosed,
}: ChangesFolderRowProps) {
  const { t } = useTranslation();
  const FolderIcon = isCollapsed ? Folder : FolderOpen;
  return (
    <div
      className="group text-muted-foreground hover:bg-sidebar-accent/50 flex items-center gap-1.5 text-xs select-none"
      style={virtualRowStyle(position, row.depth)}
      draggable
      onDragStart={(e) => {
        setFileMentionDragData(e.dataTransfer, {
          path: row.path,
          fileType: 'folder',
        });
      }}
    >
      <button
        type="button"
        onClick={() => toggleFolder(row.path)}
        aria-expanded={!isCollapsed}
        aria-label={t(isCollapsed ? 'review.expandFolder' : 'review.collapseFolder', {
          folder: row.path,
          defaultValue: `${isCollapsed ? 'Expand' : 'Collapse'} ${row.path}`,
        })}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        data-testid={`review-folder-${row.path}`}
      >
        <ChevronRight
          className={cn('icon-sm shrink-0 transition-transform', !isCollapsed && 'rotate-90')}
        />
        <FolderIcon className="icon-base text-muted-foreground/70 shrink-0" />
        <HighlightText
          text={row.label}
          query={fileSearch}
          className="font-mono-explorer flex-1 truncate text-xs"
        />
        <DiffStats linesAdded={row.additions} linesDeleted={row.deletions} size="xs" />
        {/* Spacer to align with file rows' status letter */}
        <span className="invisible shrink-0 text-xs font-medium">M</span>
      </button>
      <RowActionsMenu onClosed={onMenuClosed} triggerTestId={`review-folder-menu-${row.path}`}>
        {basePath && (
          <DropdownMenuItem
            onClick={stopThen(() => void handleOpenDirectory(row.path, false))}
            data-testid={`review-folder-open-directory-${row.path}`}
          >
            <FolderOpenDot />
            {t('sidebar.openDirectory')}
          </DropdownMenuItem>
        )}
        {/* Folder git WRITE actions — hidden for a read-only
            (steer-sharee) viewer; owner-only. */}
        {!readOnly && (
          <FolderWriteMenuItems
            path={row.path}
            handleDiscardFolder={handleDiscardFolder}
            handleIgnore={handleIgnore}
          />
        )}
      </RowActionsMenu>
    </div>
  );
}

function FolderWriteMenuItems({
  path,
  handleDiscardFolder,
  handleIgnore,
}: {
  path: string;
  handleDiscardFolder: (folderPath: string) => void;
  handleIgnore: (pattern: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem
        onClick={stopThen(() => handleDiscardFolder(path))}
        className="text-destructive focus:text-destructive"
        data-testid={`review-folder-discard-${path}`}
      >
        <Undo2 />
        {t('review.discardFolder')}
      </DropdownMenuItem>
      <IgnoreFolderMenuItems
        folders={['/' + path, ...getParentFolders(path)]}
        onIgnore={handleIgnore}
        testId={`review-folder-ignore-${path}`}
        optionTestId={(folder) => `review-folder-ignore-${path}-option-${folder}`}
      />
    </>
  );
}
