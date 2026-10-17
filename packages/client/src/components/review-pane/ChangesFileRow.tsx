import type { FileDiffSummary, FileStatus } from '@funny/shared';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  ClipboardCopy,
  Copy,
  ExternalLink,
  EyeOff,
  FileCode,
  FolderOpenDot,
  GitBranch,
  Undo2,
} from 'lucide-react';
import type { ComponentProps, Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { FileName } from '@/components/ui/file-name';
import { TriCheckbox } from '@/components/ui/tri-checkbox';
import {
  getEditorLabel,
  openFileInExternalEditor,
  openFileInInternalEditor,
} from '@/lib/editor-utils';
import { FileExtensionIcon } from '@/lib/file-icons';
import { setFileMentionDragData } from '@/lib/file-mention-dnd';
import { getFileExtension, getParentFolders } from '@/lib/file-tree';
import { cn } from '@/lib/utils';

import { DiffStats } from '../DiffStats';
import { SubmoduleBadge } from '../SubmoduleBadge';
import {
  IgnoreFolderMenuItems,
  RowActionsMenu,
  stopThen,
  virtualRowStyle,
  type RowPosition,
} from './ChangesRowParts';

type LineSelectionState = 'all' | 'partial' | 'none';
type TriCheckboxState = ComponentProps<typeof TriCheckbox>['state'];

/** Panel-wide state and handlers shared by every file row. */
export interface ChangesFileRowContext {
  fileSearch: string;
  selectedFile: string | null;
  expandedFile: string | null;
  checkedFiles: Set<string>;
  expandedSubmodules: Set<string>;
  fileSelectionState: Map<string, LineSelectionState>;
  basePath: string | undefined;
  readOnly?: boolean;
  /** Opens the diff for a row unless a row menu just closed. */
  openFileDiff: (path: string) => void;
  onMenuClosed: () => void;
  toggleFile: (path: string) => void;
  toggleSubmodule: (submodulePath: string) => void;
  setFileSelectionState: Dispatch<SetStateAction<Map<string, LineSelectionState>>>;
  setSelectAllSignal: Dispatch<SetStateAction<number>>;
  setDeselectAllSignal: Dispatch<SetStateAction<number>>;
  handleStageFile: (path: string) => void;
  handleUnstageFile: (path: string) => void;
  handleRevertFile: (path: string) => void;
  handleIgnore: (pattern: string) => void;
  handleCopyPath: (path: string, relative: boolean) => void;
  handleOpenDirectory: (path: string, isFile: boolean) => void;
}

const STATUS_STYLE: Record<FileStatus, { color: string; letter: string }> = {
  conflicted: { color: 'hsl(0 72% 51%)', letter: 'C' },
  added: { color: 'hsl(142 40% 45%)', letter: 'A' },
  modified: { color: 'hsl(30 90% 55%)', letter: 'M' },
  deleted: { color: 'hsl(0 45% 55%)', letter: 'D' },
  renamed: { color: 'hsl(200 80% 60%)', letter: 'R' },
};

function statusStyle(status: FileStatus) {
  return STATUS_STYLE[status] ?? STATUS_STYLE.renamed;
}

/** Submodules report the line counts of their nested repo when available. */
function fileLineStats(f: FileDiffSummary): { added: number; deleted: number } {
  if (f.kind === 'submodule' && f.nestedDirty) {
    return { added: f.nestedDirty.linesAdded, deleted: f.nestedDirty.linesDeleted };
  }
  return { added: f.additions ?? 0, deleted: f.deletions ?? 0 };
}

function checkboxState(isChecked: boolean, isPartial: boolean): TriCheckboxState {
  if (isPartial) return 'indeterminate';
  return isChecked ? 'checked' : 'unchecked';
}

function setLineSelection(ctx: ChangesFileRowContext, path: string, state: LineSelectionState) {
  ctx.setFileSelectionState((prev) => {
    const next = new Map(prev);
    next.set(path, state);
    return next;
  });
}

/**
 * Checkbox toggle for a file row. Partial or unchecked → check the file and
 * re-select all of its lines; checked → uncheck and deselect all lines. The
 * expanded diff view is signalled so its line selection follows.
 */
function toggleFileCheck(
  ctx: ChangesFileRowContext,
  path: string,
  isChecked: boolean,
  isPartial: boolean,
) {
  const isExpanded = ctx.expandedFile === path;
  if (isPartial || !isChecked) {
    if (!isChecked) ctx.toggleFile(path);
    if (isExpanded) ctx.setSelectAllSignal((s) => s + 1);
    setLineSelection(ctx, path, 'all');
    return;
  }
  ctx.toggleFile(path);
  if (isExpanded) ctx.setDeselectAllSignal((s) => s + 1);
  setLineSelection(ctx, path, 'none');
}

/** File (or submodule) row of the Changes file list. */
export function ChangesFileRow({
  file: f,
  position,
  depth,
  ctx,
}: {
  file: FileDiffSummary;
  position: RowPosition;
  depth: number;
  ctx: ChangesFileRowContext;
}) {
  const { t } = useTranslation();
  const isChecked = ctx.checkedFiles.has(f.path);
  const isPartial = isChecked && ctx.fileSelectionState.get(f.path) === 'partial';
  const isSelected = ctx.selectedFile === f.path;
  const isSubmodule = f.kind === 'submodule';
  return (
    <div
      style={virtualRowStyle(position, depth)}
      className={cn(
        'group flex items-center gap-1.5 text-xs',
        isSelected
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'hover:bg-sidebar-accent/50 text-muted-foreground',
      )}
      draggable
      onDragStart={(e) => {
        setFileMentionDragData(e.dataTransfer, {
          path: f.path,
          fileType: 'file',
        });
      }}
    >
      <TriCheckbox
        state={checkboxState(isChecked, isPartial)}
        onToggle={(e) => {
          e.stopPropagation();
          toggleFileCheck(ctx, f.path, isChecked, isPartial);
        }}
        aria-label={t('review.selectFile', {
          file: f.path,
          defaultValue: `Select ${f.path}`,
        })}
        data-testid={`review-file-checkbox-${f.path}`}
      />
      {isSubmodule && (
        <SubmoduleToggle
          path={f.path}
          expanded={ctx.expandedSubmodules.has(f.path)}
          onToggle={ctx.toggleSubmodule}
        />
      )}
      <button
        type="button"
        onClick={() => ctx.openFileDiff(f.path)}
        aria-label={t('review.openFileDiff', {
          file: f.path,
          defaultValue: `Open diff for ${f.path}`,
        })}
        aria-current={isSelected ? 'true' : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
      >
        <FileRowSummary file={f} fileSearch={ctx.fileSearch} />
      </button>
      <RowActionsMenu onClosed={ctx.onMenuClosed}>
        <FileRowMenuItems file={f} ctx={ctx} />
      </RowActionsMenu>
    </div>
  );
}

function SubmoduleToggle({
  path,
  expanded,
  onToggle,
}: {
  path: string;
  expanded: boolean;
  onToggle: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      onClick={stopThen(() => onToggle(path))}
      aria-label={
        expanded
          ? t('review.collapseSubmodule', { defaultValue: 'Collapse submodule' })
          : t('review.expandSubmodule', { defaultValue: 'Expand submodule' })
      }
      className="text-muted-foreground hover:text-foreground flex size-4 shrink-0 items-center justify-center rounded"
      data-testid={`review-submodule-toggle-${path}`}
    >
      <ChevronRight className={cn('icon-sm transition-transform', expanded && 'rotate-90')} />
    </button>
  );
}

/** Icon, name, submodule badge, line stats and status letter of a file row. */
function FileRowSummary({ file: f, fileSearch }: { file: FileDiffSummary; fileSearch: string }) {
  const isSubmodule = f.kind === 'submodule';
  const stats = fileLineStats(f);
  const status = statusStyle(f.status);
  return (
    <>
      {isSubmodule ? (
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
      <FileName
        name={f.path.split('/').pop() || f.path}
        query={fileSearch}
        preserveExtension={!isSubmodule}
        className="font-mono-explorer text-xs"
      />
      {isSubmodule && (
        <SubmoduleBadge
          nested={f.nestedDirty}
          testId={`review-submodule-badge-${f.path}`}
          showExpandHint
        />
      )}
      <DiffStats linesAdded={stats.added} linesDeleted={stats.deleted} size="xs" />
      <span className="shrink-0 text-xs font-medium" style={{ color: status.color }}>
        {status.letter}
      </span>
    </>
  );
}

function FileRowMenuItems({ file: f, ctx }: { file: FileDiffSummary; ctx: ChangesFileRowContext }) {
  const { t } = useTranslation();
  const { basePath } = ctx;
  const openWith = (open: (absPath: string) => void) =>
    stopThen(() => {
      if (!basePath) {
        toast.error(t('review.openFileNoBasePath'));
        return;
      }
      open(`${basePath}/${f.path}`);
    });
  return (
    <>
      <DropdownMenuItem onClick={openWith(openFileInExternalEditor)}>
        <ExternalLink />
        {t('review.openInEditor', { editor: getEditorLabel() })}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={openWith(openFileInInternalEditor)}
        data-testid={`review-open-internal-editor-${f.path}`}
      >
        <FileCode />
        {t('review.openInInternalEditor')}
      </DropdownMenuItem>
      {basePath && (
        <DropdownMenuItem
          onClick={stopThen(() => void ctx.handleOpenDirectory(f.path, true))}
          data-testid={`review-file-open-directory-${f.path}`}
        >
          <FolderOpenDot />
          {t('sidebar.openDirectory')}
        </DropdownMenuItem>
      )}
      {/* Per-file git WRITE actions — hidden for a read-only
          (steer-sharee) viewer; they are owner-only. */}
      {!ctx.readOnly && <FileWriteMenuItems file={f} ctx={ctx} />}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={stopThen(() => ctx.handleCopyPath(f.path, false))}>
        <Copy />
        {t('review.copyFilePath')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={stopThen(() => ctx.handleCopyPath(f.path, true))}>
        <ClipboardCopy />
        {t('review.copyRelativePath')}
      </DropdownMenuItem>
    </>
  );
}

function FileWriteMenuItems({
  file: f,
  ctx,
}: {
  file: FileDiffSummary;
  ctx: ChangesFileRowContext;
}) {
  const { t } = useTranslation();
  const ext = getFileExtension(f.path);
  return (
    <>
      <DropdownMenuSeparator />
      {f.staged ? (
        <DropdownMenuItem
          onClick={stopThen(() => ctx.handleUnstageFile(f.path))}
          data-testid={`review-unstage-file-${f.path}`}
        >
          <ArchiveRestore />
          {t('review.unstageFile', { defaultValue: 'Unstage file' })}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          onClick={stopThen(() => ctx.handleStageFile(f.path))}
          data-testid={`review-stage-file-${f.path}`}
        >
          <Archive />
          {t('review.stageFile', { defaultValue: 'Stage file' })}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={stopThen(() => ctx.handleRevertFile(f.path))}
        className="text-destructive focus:text-destructive"
      >
        <Undo2 />
        {t('review.discardChanges')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={stopThen(() => ctx.handleIgnore(f.path))}>
        <EyeOff />
        {t('review.ignoreFile')}
      </DropdownMenuItem>
      <IgnoreFolderMenuItems folders={getParentFolders(f.path)} onIgnore={ctx.handleIgnore} />
      {ext && (
        <DropdownMenuItem onClick={stopThen(() => ctx.handleIgnore(`*${ext}`))}>
          <EyeOff />
          {t('review.ignoreExtension', { ext })}
        </DropdownMenuItem>
      )}
    </>
  );
}
