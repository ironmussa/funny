import type { FileDiffSummary, PRReviewThread } from '@funny/shared';
import { FileCode, X } from 'lucide-react';
import { type ComponentType, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadingState } from '@/components/ui/loading-state';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useIsMobile } from '@/hooks/use-mobile';
import { computeUnifiedDiff } from '@/lib/snippet-unified-diff';

import { FileTree } from '../FileTree';
import { type DiffViewMode, type ConflictResolution, VirtualDiff } from '../VirtualDiff';
import {
  CopyFullFileButton,
  DiffHeaderControls,
  DiffMarkdownPreview,
  DiffReviewThreads,
  DiffSearchOverlay,
} from './ExpandedDiffToolbar';
import { getFileName } from './format-utils';
import {
  deriveDiffDisplay,
  lineSelectionProps,
  resolveEffectiveDiff,
  useDiffKeyboardShortcuts,
  useDiffLineSelection,
  useExpandedDiffControls,
  type DiffDisplay,
  type DiffValues,
  type ExpandedDiffControls,
  type RequestFullDiff,
} from './use-expanded-diff-controls';

/* ── Props ── */

interface ExpandedDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  oldValue: string;
  newValue: string;
  /** 1-indexed line in the real file where old/new snippets begin */
  baseLine?: number;
  icon?: ComponentType<{ className?: string }>;
  loading?: boolean;
  description?: string;
  files?: FileDiffSummary[];
  onFileSelect?: (filePath: string) => void;
  diffCache?: Map<string, string>;
  loadingDiffPath?: string | null;
  checkedFiles?: Set<string>;
  onToggleFile?: (path: string) => void;
  onRevertFile?: (path: string) => void;
  onIgnore?: (pattern: string) => void;
  basePath?: string;
  prReviewThreads?: PRReviewThread[];
  onRequestFullDiff?: RequestFullDiff;
}

/** Props for the inline (non-dialog) expanded diff view */
export interface ExpandedDiffViewProps {
  filePath: string;
  oldValue: string;
  newValue: string;
  icon?: ComponentType<{ className?: string }>;
  loading?: boolean;
  rawDiff?: string;
  files?: FileDiffSummary[];
  onFileSelect?: (filePath: string) => void;
  diffCache?: Map<string, string>;
  onClose?: () => void;
  prReviewThreads?: PRReviewThread[];
  onResolveConflict?: (blockId: number, resolution: ConflictResolution) => void;
  onRequestFullDiff?: RequestFullDiff;
  /** Enable line-level selection for partial staging */
  selectable?: boolean;
  /** Called with a constructed patch string when user clicks "Stage Selected Lines" */
  onStagePatch?: (patch: string) => void;
  /** Called with a constructed patch when user clicks "Unstage Selected Lines" */
  onUnstagePatch?: (patch: string) => void;
  /** Whether staging is in progress */
  stagingInProgress?: boolean;
  /** Reports selection state changes: 'all' | 'partial' | 'none' for the current file */
  onSelectionStateChange?: (filePath: string, state: 'all' | 'partial' | 'none') => void;
  /** Increment this counter to force re-select all lines (used when file checkbox is re-checked) */
  selectAllSignal?: number;
  /** Increment this counter to force deselect all lines (used when file checkbox is unchecked) */
  deselectAllSignal?: number;
  /** Initial view mode before the user toggles it. Defaults to 'three-pane';
   *  the mobile diff view passes 'unified' since multi-pane is unusable on a phone. */
  initialViewMode?: DiffViewMode;
}

/* ── Diff content ── */

function DiffContent({
  filePath,
  splitView,
  viewMode,
  loading,
  rawDiff,
  oldValue,
  newValue,
  baseLine,
  showFullFile,
  wordWrap,
  searchQuery,
  searchCaseSensitive,
  currentMatchIndex,
  onMatchCount,
  onResolveConflict,
  selectable,
  selectedLines,
  onLineToggle,
  onHunkToggle,
  onDragSelect,
}: {
  filePath: string;
  /** @deprecated Use viewMode instead */
  splitView: boolean;
  viewMode?: DiffViewMode;
  loading: boolean;
  rawDiff?: string;
  oldValue: string;
  newValue: string;
  /** 1-indexed line in the real file where old/new snippets begin */
  baseLine?: number;
  /** When true, disable code folding so the entire file is visible */
  showFullFile?: boolean;
  wordWrap?: boolean;
  searchQuery?: string;
  searchCaseSensitive?: boolean;
  currentMatchIndex?: number;
  onMatchCount?: (count: number) => void;
  onResolveConflict?: (blockId: number, resolution: ConflictResolution) => void;
  selectable?: boolean;
  selectedLines?: Set<number>;
  onLineToggle?: (lineIdx: number) => void;
  onHunkToggle?: (hunkLineIndices: number[]) => void;
  onDragSelect?: (startLineIdx: number, endLineIdx: number, select: boolean) => void;
}) {
  const { t } = useTranslation();

  // Compute unified diff from old/new if rawDiff is not provided
  const unifiedDiff = useMemo(() => {
    if (rawDiff) return rawDiff;
    if (!oldValue && !newValue) return '';
    return computeUnifiedDiff(oldValue, newValue, baseLine);
  }, [rawDiff, oldValue, newValue, baseLine]);

  if (loading) {
    return (
      <LoadingState
        testId="expanded-diff-loading"
        label={t('review.loading', 'Loading changes…')}
      />
    );
  }

  if (!unifiedDiff) {
    return <p className="text-muted-foreground p-4 text-xs">No diff available</p>;
  }

  return (
    <VirtualDiff
      unifiedDiff={unifiedDiff}
      viewMode={viewMode}
      splitView={splitView}
      filePath={filePath}
      codeFolding={!showFullFile}
      showMinimap={!!showFullFile}
      wordWrap={wordWrap}
      searchQuery={searchQuery}
      searchCaseSensitive={searchCaseSensitive}
      currentMatchIndex={currentMatchIndex}
      onMatchCount={onMatchCount}
      onResolveConflict={onResolveConflict}
      selectable={selectable}
      selectedLines={selectedLines}
      onLineToggle={onLineToggle}
      onHunkToggle={onHunkToggle}
      onDragSelect={onDragSelect}
      className="h-full"
      data-testid="expanded-diff-viewer"
    />
  );
}

/* ── Shared scrollable diff / markdown surface ── */

function DiffScrollPane({
  filePath,
  testIdPrefix,
  controls,
  display,
  markdownContent,
  effective,
  loading,
  baseLine,
  onResolveConflict,
  selectionProps,
}: {
  filePath: string;
  testIdPrefix: string;
  controls: ExpandedDiffControls;
  display: DiffDisplay;
  markdownContent: string;
  effective: DiffValues;
  loading: boolean;
  baseLine?: number;
  onResolveConflict?: (blockId: number, resolution: ConflictResolution) => void;
  selectionProps?: ReturnType<typeof lineSelectionProps>;
}) {
  const { search, showFullFile } = controls;
  const { viewMode } = display;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {display.showMarkdownPreview ? (
        <DiffMarkdownPreview
          content={markdownContent}
          testId={`${testIdPrefix}-markdown-preview`}
        />
      ) : (
        <DiffContent
          filePath={filePath}
          splitView={viewMode === 'split'}
          viewMode={viewMode}
          loading={loading}
          rawDiff={effective.rawDiff}
          oldValue={effective.oldValue}
          newValue={effective.newValue}
          baseLine={showFullFile ? 1 : baseLine}
          showFullFile={showFullFile}
          wordWrap={controls.wordWrap}
          searchQuery={search.showSearch ? search.searchQuery : undefined}
          searchCaseSensitive={search.searchCaseSensitive}
          currentMatchIndex={search.currentMatchIndex}
          onMatchCount={search.handleMatchCount}
          onResolveConflict={onResolveConflict}
          {...selectionProps}
        />
      )}
    </div>
  );
}

function useFileReviewThreads(prReviewThreads: PRReviewThread[] | undefined, filePath: string) {
  return useMemo(
    () => (prReviewThreads ?? []).filter((t) => t.path === filePath),
    [prReviewThreads, filePath],
  );
}

/* ── Main component ── */

/** Remember the focused element on open and restore it (without scrolling) on close. */
function useReturnFocus() {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onOpenAutoFocus = useCallback((e: Event) => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    e.preventDefault();
  }, []);
  const onCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
    returnFocusRef.current?.focus({ preventScroll: true });
  }, []);
  return { onOpenAutoFocus, onCloseAutoFocus };
}

function useExpandedDiffDialogModel({
  open,
  filePath,
  oldValue,
  newValue,
  files,
  diffCache,
  prReviewThreads,
  onRequestFullDiff,
}: ExpandedDiffDialogProps) {
  const isMobile = useIsMobile();
  const [copied, copy] = useCopyToClipboard();
  const controls = useExpandedDiffControls({
    filePath,
    onRequestFullDiff,
    initialViewMode: 'three-pane',
  });
  const { search, fullDiff, showFullFile, requestFullFile } = controls;

  const copyFullFileText = useCallback(async () => {
    const fullFile = onRequestFullDiff ? await requestFullFile() : fullDiff;
    const currentText = fullFile?.newValue || fullFile?.oldValue || newValue || oldValue;
    if (currentText) copy(currentText);
  }, [onRequestFullDiff, requestFullFile, fullDiff, newValue, oldValue, copy]);

  useDiffKeyboardShortcuts({
    enabled: open,
    canOpenSearch: controls.markdownPreviewPath !== filePath,
    search,
  });

  const fileThreads = useFileReviewThreads(prReviewThreads, filePath);

  // Determine which raw diff / old/new values to pass
  const effective = resolveEffectiveDiff(fullDiff, showFullFile, {
    rawDiff: diffCache?.get(filePath),
    oldValue,
    newValue,
  });

  const display = deriveDiffDisplay({
    filePath,
    status: files?.find((f) => f.path === filePath)?.status,
    effective,
    userViewMode: controls.userViewMode,
    forceUnified: isMobile,
    isDeletedFile: effective.newValue === '' && effective.oldValue !== '',
    hasFullDiffProvider: !!onRequestFullDiff,
    markdownPreviewPath: controls.markdownPreviewPath,
  });

  return {
    controls,
    display,
    effective,
    fileThreads,
    copied,
    copyFullFileText,
    copyDisabled: controls.loadingFullDiff || (!onRequestFullDiff && !newValue && !oldValue),
    markdownContent: fullDiff?.newValue ?? newValue,
  };
}

function DiffFileSidebar({
  filePath,
  files,
  onFileSelect,
  checkedFiles,
  onToggleFile,
  onRevertFile,
  onIgnore,
  basePath,
}: Pick<
  ExpandedDiffDialogProps,
  | 'filePath'
  | 'files'
  | 'onFileSelect'
  | 'checkedFiles'
  | 'onToggleFile'
  | 'onRevertFile'
  | 'onIgnore'
  | 'basePath'
>) {
  if (!files || files.length === 0 || !onFileSelect) return null;
  return (
    <div className="border-border flex w-80 shrink-0 flex-col border-r">
      <div className="border-border text-muted-foreground border-b px-3 py-2 text-xs font-semibold tracking-wider uppercase">
        Files
      </div>
      <div className="min-h-0 flex-1">
        <FileTree
          files={files}
          selectedFile={filePath}
          onFileClick={onFileSelect}
          checkedFiles={checkedFiles}
          onToggleFile={onToggleFile}
          onRevertFile={onRevertFile}
          onIgnore={onIgnore}
          basePath={basePath}
          fontSize="text-xs"
          activeClass="bg-sidebar-accent text-sidebar-accent-foreground"
          hoverClass="hover:bg-sidebar-accent/50 text-muted-foreground"
          testIdPrefix="diff-sidebar"
          virtualize
        />
      </div>
    </div>
  );
}

export function ExpandedDiffDialog(props: ExpandedDiffDialogProps) {
  const {
    open,
    onOpenChange,
    filePath,
    baseLine,
    icon: Icon = FileCode,
    loading = false,
    description,
  } = props;
  const focus = useReturnFocus();
  const { controls, display, effective, fileThreads, ...copyState } =
    useExpandedDiffDialogModel(props);
  const { search } = controls;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) controls.clearMarkdownPreview();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="flex h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 md:h-[85vh] md:w-[90vw] md:max-w-[90vw] md:rounded-lg"
        onOpenAutoFocus={focus.onOpenAutoFocus}
        onCloseAutoFocus={focus.onCloseAutoFocus}
        onEscapeKeyDown={(e) => {
          if (search.showSearch) e.preventDefault();
        }}
      >
        <DialogHeader className="border-border shrink-0 overflow-hidden border-b px-4 py-3 select-none">
          <DialogTitle className="flex min-w-0 items-center gap-2 overflow-hidden font-mono text-sm">
            <Icon className="icon-base shrink-0" />
            <span
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {filePath}
            </span>
          </DialogTitle>
          <DiffHeaderControls testIdPrefix="diff" controls={controls} display={display}>
            <CopyFullFileButton
              onCopy={() => void copyState.copyFullFileText()}
              disabled={copyState.copyDisabled}
              loading={controls.loadingFullDiff}
              copied={copyState.copied}
            />
          </DiffHeaderControls>
          <DialogDescription className="sr-only">
            {description || `Diff for ${getFileName(filePath)}`}
          </DialogDescription>
        </DialogHeader>

        <div className="relative flex min-h-0 flex-1">
          <DiffSearchOverlay search={search} display={display} testIdPrefix="diff" />
          <DiffFileSidebar {...props} />

          {/* Diff content + review threads */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <DiffScrollPane
              filePath={filePath}
              testIdPrefix="diff"
              controls={controls}
              display={display}
              markdownContent={copyState.markdownContent}
              effective={effective}
              loading={loading}
              baseLine={baseLine}
            />
            <DiffReviewThreads threads={fileThreads} testId="diff-review-threads" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Inline expanded diff view (no dialog, no file tree) ── */

/** The inline view treats a file as deleted from its git status or its (non-full-file) values. */
function isDeletedSource(status: string | undefined, oldValue: string, newValue: string) {
  return status === 'deleted' || (newValue === '' && oldValue !== '');
}

function useExpandedDiffViewModel({
  filePath,
  oldValue,
  newValue,
  rawDiff,
  files,
  diffCache,
  onClose,
  prReviewThreads,
  onRequestFullDiff,
  selectable = false,
  onSelectionStateChange,
  selectAllSignal = 0,
  deselectAllSignal = 0,
  initialViewMode = 'three-pane',
}: ExpandedDiffViewProps) {
  const controls = useExpandedDiffControls({ filePath, onRequestFullDiff, initialViewMode });
  const { search, fullDiff, showFullFile } = controls;

  const currentFileStatus = files?.find((f) => f.path === filePath)?.status;
  const baseRawDiff = rawDiff ?? diffCache?.get(filePath);

  const selection = useDiffLineSelection({
    filePath,
    selectable,
    diffText: baseRawDiff,
    selectAllSignal,
    deselectAllSignal,
    onSelectionStateChange,
  });

  useDiffKeyboardShortcuts({
    enabled: true,
    canOpenSearch: controls.markdownPreviewPath !== filePath,
    search,
    onIdleEscape: onClose,
  });

  const fileThreads = useFileReviewThreads(prReviewThreads, filePath);

  // Determine which raw diff / old/new values to pass
  const effective = resolveEffectiveDiff(fullDiff, showFullFile, {
    rawDiff: baseRawDiff,
    oldValue,
    newValue,
  });

  const display = deriveDiffDisplay({
    filePath,
    status: currentFileStatus,
    effective,
    userViewMode: controls.userViewMode,
    forceUnified: false,
    isDeletedFile: isDeletedSource(currentFileStatus, oldValue, newValue),
    hasFullDiffProvider: !!onRequestFullDiff,
    markdownPreviewPath: controls.markdownPreviewPath,
  });

  return {
    controls,
    display,
    effective,
    fileThreads,
    markdownContent: fullDiff?.newValue ?? '',
    // Line selection (partial staging) is only available in unified mode
    selectionProps: lineSelectionProps(selectable && display.viewMode === 'unified', selection),
  };
}

function CloseDiffButton({ onClose }: { onClose?: () => void }) {
  if (!onClose) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClose}
      className="text-muted-foreground shrink-0"
      data-testid="expanded-diff-close"
    >
      <X className="icon-base" />
    </Button>
  );
}

export function ExpandedDiffView(props: ExpandedDiffViewProps) {
  const { filePath, icon: Icon = FileCode, loading = false, onClose, onResolveConflict } = props;
  const { controls, display, effective, fileThreads, markdownContent, selectionProps } =
    useExpandedDiffViewModel(props);

  return (
    <div className="bg-background flex h-full flex-col" data-testid="expanded-diff-view">
      {/* Header toolbar */}
      <div className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-4 select-none">
        <Icon className="icon-base text-muted-foreground shrink-0" />
        <span
          className="text-foreground min-w-0 flex-1 overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap"
          style={{ direction: 'rtl', textAlign: 'left' }}
        >
          {filePath}
        </span>
        <DiffHeaderControls testIdPrefix="diff-view" controls={controls} display={display} />
        <CloseDiffButton onClose={onClose} />
      </div>

      {/* Diff content + review threads */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <DiffSearchOverlay search={controls.search} display={display} testIdPrefix="diff-view" />
        <DiffScrollPane
          filePath={filePath}
          testIdPrefix="diff-view"
          controls={controls}
          display={display}
          markdownContent={markdownContent}
          effective={effective}
          loading={loading || controls.loadingFullDiff}
          onResolveConflict={onResolveConflict}
          selectionProps={selectionProps}
        />
        <DiffReviewThreads threads={fileThreads} testId="diff-view-review-threads" />
      </div>
    </div>
  );
}
