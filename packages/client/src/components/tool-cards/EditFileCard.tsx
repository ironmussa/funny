import { ChevronRight, FilePen, Loader2, Maximize2 } from 'lucide-react';
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { VirtualDiff } from '@/components/VirtualDiff';
import { buildSections, buildVirtualRows } from '@/lib/diff/layout';
import { parseUnifiedDiff } from '@/lib/diff/parse';
import { cn } from '@/lib/utils';
import { DIFF_ROW_HEIGHT_PX, useSettingsStore } from '@/stores/settings-store';

import { ExpandedDiffDialog } from './ExpandedDiffDialog';
import { FileLink } from './GenericToolCard';
import { MobileContentPreview } from './MobileContentPreview';
import { useDiffMountOnVisible, useEditFileDiff } from './use-edit-file-diff';

const INLINE_DIFF_CONTEXT_LINES = 3;

const PATH_BUTTON_CLASS =
  'text-muted-foreground hover:text-primary min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-xs hover:underline';

/** Height reserved for the inline diff: the rows VirtualDiff renders with folding on. */
function useInlineDiffSlotHeight(unifiedDiff: string): number {
  const fontSize = useSettingsStore((s) => s.fontSize);
  return useMemo(() => {
    const rowHeight = DIFF_ROW_HEIGHT_PX[fontSize];
    const parsedDiff = parseUnifiedDiff(unifiedDiff);
    const sections = buildSections(parsedDiff.lines, INLINE_DIFF_CONTEXT_LINES);
    const visibleRows = buildVirtualRows(
      sections,
      parsedDiff.lines,
      parsedDiff.hunkHeaders,
      INLINE_DIFF_CONTEXT_LINES,
    );
    // VirtualDiff folds long unchanged sections by default. Reserve space for
    // the rows it actually renders, not every line in the raw patch; otherwise
    // a small edit in a large hunk leaves a tall empty panel below the diff.
    const conflictStartLines = new Set(
      parsedDiff.conflictBlocks.map((block) => block.startLineIdx),
    );
    const visibleConflictActions = visibleRows.filter(
      (row) => row.type === 'line' && conflictStartLines.has(row.lineIdx),
    ).length;
    const visibleRowCount = visibleRows.length + visibleConflictActions;
    return Math.max(64, visibleRowCount * rowHeight);
  }, [fontSize, unifiedDiff]);
}

/**
 * The card's file path. When a diff is available, clicking the path opens the
 * diff popup. Otherwise fall back to opening the file in the editor.
 */
function EditFilePathLink({
  filePath,
  displayPath,
  hasDiff,
  onExpand,
}: {
  filePath: string;
  displayPath: string | undefined;
  hasDiff: boolean;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  if (hasDiff) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
            className={PATH_BUTTON_CLASS}
          >
            {displayPath}
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('review.expand', 'Expand')}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <FileLink
      filePath={filePath}
      displayPath={displayPath}
      defaultEditor={defaultEditor}
      buttonClassName={PATH_BUTTON_CLASS}
    />
  );
}

function EditFileHeader({
  expanded,
  onToggle,
  hideLabel,
  filePath,
  displayPath,
  displayTime,
  hasDiff,
  onExpand,
}: {
  expanded: boolean;
  onToggle: () => void;
  hideLabel?: boolean;
  filePath: string | undefined;
  displayPath: string | undefined;
  displayTime?: string | null;
  hasDiff: boolean;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full items-center overflow-hidden">
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        <button
          type="button"
          onClick={onToggle}
          aria-label={t('tools.editFile')}
          className="hover:bg-accent/30 flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs"
        >
          <ChevronRight
            className={cn('icon-xs shrink-0 text-muted-foreground', expanded && 'rotate-90')}
          />
          {!hideLabel && <FilePen className="icon-xs text-muted-foreground shrink-0" />}
          {!hideLabel && (
            <span className="text-foreground shrink-0 font-mono font-medium">
              {t('tools.editFile')}
            </span>
          )}
        </button>
        {filePath && (
          <EditFilePathLink
            filePath={filePath}
            displayPath={displayPath}
            hasDiff={hasDiff}
            onExpand={onExpand}
          />
        )}
        {displayTime && (
          <span className="text-muted-foreground/50 text-2xs ml-auto shrink-0 tabular-nums">
            {displayTime}
          </span>
        )}
      </div>
      {hasDiff && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="muted" size="icon-xs" onClick={onExpand} className="mr-1 shrink-0">
              <Maximize2 className="icon-sm" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('review.expand', 'Expand')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function EditFileInlineDiff({
  diffMounted,
  diffSlotRef,
  onExpand,
  unifiedDiff,
  filePath,
}: {
  diffMounted: boolean;
  diffSlotRef: (el: HTMLDivElement | null) => void;
  onExpand: () => void;
  unifiedDiff: string;
  filePath: string | undefined;
}) {
  const { t } = useTranslation();
  const inlineDiffSlotHeight = useInlineDiffSlotHeight(unifiedDiff);
  return (
    <MobileContentPreview onExpand={onExpand} label={t('tools.viewFullDiff')}>
      <div
        ref={diffSlotRef}
        className="border-border/40 max-h-[50vh] overflow-hidden border-t"
        style={{ height: inlineDiffSlotHeight }}
      >
        {diffMounted ? (
          <VirtualDiff
            unifiedDiff={unifiedDiff}
            splitView={false}
            filePath={filePath}
            codeFolding={true}
            contextLines={INLINE_DIFF_CONTEXT_LINES}
            className="h-full max-h-[50vh]"
            data-testid="edit-file-inline-diff"
          />
        ) : (
          <div
            className="text-muted-foreground flex h-16 items-center gap-2 px-3 text-xs"
            data-testid="edit-file-inline-diff-placeholder"
          >
            <Loader2 className="icon-xs animate-spin" />
            <span>{t('tools.loadingDiff', 'Loading diff…')}</span>
          </div>
        )}
      </div>
    </MobileContentPreview>
  );
}

function EditFileDiffUnavailable({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="border-border/40 flex min-h-16 items-center justify-between gap-3 border-t px-3 py-2 text-xs"
      data-testid="edit-file-inline-diff-unavailable"
    >
      <span className="text-muted-foreground">
        {t(
          'tools.diffUnavailableNoTracking',
          'The diff cannot be shown because this file is not tracked by Git.',
        )}
      </span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        {t('common.retry', 'Retry')}
      </Button>
    </div>
  );
}

export function EditFileCard({
  parsed,
  hideLabel,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  hideLabel?: boolean;
  displayTime?: string | null;
}) {
  // hideLabel selects the initial uncontrolled state; user toggles own expansion after mount.
  // react-doctor-disable-next-line no-derived-useState
  const [expanded, setExpanded] = useState(!hideLabel);
  const [showExpandedDiff, setShowExpandedDiff] = useState(false);
  const { diffMounted, diffSlotRef } = useDiffMountOnVisible(expanded);
  const diff = useEditFileDiff(parsed, expanded, diffMounted);
  const { filePath, hasDiff, isDiffLoading, isDiffUnavailable, dialogFiles } = diff;
  const openExpandedDiff = () => setShowExpandedDiff(true);

  return (
    <div
      data-expanded={expanded}
      className="tool-card-frame w-full min-w-0 overflow-hidden rounded-lg text-sm"
    >
      <EditFileHeader
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        hideLabel={hideLabel}
        filePath={filePath}
        displayPath={diff.displayPath}
        displayTime={displayTime}
        hasDiff={hasDiff}
        onExpand={openExpandedDiff}
      />
      {expanded && hasDiff && (
        <EditFileInlineDiff
          diffMounted={diffMounted}
          diffSlotRef={diffSlotRef}
          onExpand={openExpandedDiff}
          unifiedDiff={diff.unifiedDiff}
          filePath={filePath}
        />
      )}
      {expanded && !hasDiff && isDiffLoading && (
        <div
          className="border-border/40 bg-muted/20 h-16 animate-pulse border-t"
          data-testid="edit-file-inline-diff-loading"
        />
      )}
      {expanded && !hasDiff && !isDiffLoading && isDiffUnavailable && filePath && (
        <EditFileDiffUnavailable onRetry={() => diff.retryDiff(filePath)} />
      )}
      <ExpandedDiffDialog
        open={showExpandedDiff}
        onOpenChange={setShowExpandedDiff}
        filePath={filePath || ''}
        oldValue={diff.oldString || ''}
        newValue={diff.newString || ''}
        baseLine={diff.snippetBaseLine}
        files={dialogFiles}
        onFileSelect={dialogFiles ? diff.setRequestedFilePath : undefined}
        diffCache={diff.diffCache}
        basePath={diff.projectPath}
        onRequestFullDiff={diff.requestFullDiff}
      />
    </div>
  );
}
