import type { VirtualItem } from '@tanstack/react-virtual';
import type { TFunction } from 'i18next';
import { MoreHorizontal, FolderX } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { TreeRow } from '@/components/FileTree';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Shared building blocks for the virtualized rows of the Changes file list
 * (`ChangesFilesPanel`): row positioning, the per-row "more actions" menu and
 * the "ignore folder" items used by both folder and file rows.
 */

const INDENT_PX = 12;

export type RowPosition = Pick<VirtualItem, 'size' | 'start'>;

type SubmoduleStatusRow = Extract<TreeRow, { kind: 'submodule-status' }>;

/** Absolute positioning for a virtualized row, indented by tree depth. */
export function virtualRowStyle(position: RowPosition, depth: number): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: `${position.size}px`,
    transform: `translateY(${position.start}px)`,
    paddingLeft: `${8 + depth * INDENT_PX}px`,
  };
}

type StopPropagationEvent = { stopPropagation(): void };

const stopPropagation = (e: StopPropagationEvent) => e.stopPropagation();

/** Click handler that stops propagation before running `action`. */
export function stopThen(action: () => void) {
  return (e: StopPropagationEvent) => {
    e.stopPropagation();
    action();
  };
}

/**
 * Row "more actions" dropdown. `onClosed` lets the panel ignore the row click
 * that immediately follows closing the menu.
 */
export function RowActionsMenu({
  onClosed,
  triggerTestId,
  children,
}: {
  onClosed: () => void;
  triggerTestId?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) onClosed();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          onClick={stopPropagation}
          onPointerDown={stopPropagation}
          aria-label={t('review.moreActions', 'More actions')}
          className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-[color,background-color,opacity] group-hover:opacity-100 data-[state=open]:opacity-100"
          data-testid={triggerTestId}
        >
          <MoreHorizontal className="icon-sm" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[220px]"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "Ignore folder" menu entry: nothing for no candidates, a single item for one
 * candidate, otherwise a submenu listing every candidate folder.
 */
export function IgnoreFolderMenuItems({
  folders,
  onIgnore,
  testId,
  optionTestId,
}: {
  folders: string[];
  onIgnore: (pattern: string) => void;
  testId?: string;
  optionTestId?: (folder: string) => string;
}) {
  const { t } = useTranslation();
  if (folders.length === 0) return null;
  if (folders.length === 1) {
    return (
      <DropdownMenuItem onClick={stopThen(() => onIgnore(folders[0]))} data-testid={testId}>
        <FolderX />
        {t('review.ignoreFolder')}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
        data-testid={testId}
      >
        <FolderX />
        {t('review.ignoreFolder')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent onClick={stopPropagation} onPointerDown={stopPropagation}>
        {folders.map((folder) => (
          <DropdownMenuItem
            key={folder}
            onClick={stopThen(() => onIgnore(folder))}
            data-testid={optionTestId?.(folder)}
          >
            {folder}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function submoduleStatusLabel(row: SubmoduleStatusRow, t: TFunction): string {
  if (row.state === 'loading') {
    return t('review.submoduleLoading', { defaultValue: 'Loading submodule files…' });
  }
  if (row.state === 'error') {
    return row.message ?? t('review.submoduleError', { defaultValue: 'Failed to load submodule' });
  }
  return t('review.submoduleEmpty', { defaultValue: 'No changes inside submodule' });
}

/** Placeholder row shown under an expanded submodule (loading / error / empty). */
export function SubmoduleStatusRowView({
  row,
  position,
}: {
  row: SubmoduleStatusRow;
  position: RowPosition;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="text-muted-foreground/80 flex items-center gap-1.5 text-xs italic"
      style={virtualRowStyle(position, row.depth)}
      data-testid={`review-submodule-status-${row.submodulePath}`}
    >
      <span className="truncate">{submoduleStatusLabel(row, t)}</span>
    </div>
  );
}
