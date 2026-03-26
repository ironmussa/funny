import type { FileDiffSummary } from '@funny/shared';
import { Columns2, FileCode, Loader2, Rows2 } from 'lucide-react';
import { type ComponentType, Suspense, useState, useCallback, useRef, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDiffHighlight } from '@/hooks/use-diff-highlight';

import { FileTree } from '../FileTree';
import { ReactDiffViewer, DIFF_VIEWER_STYLES, getFileName } from './utils';

/* ── Props ── */

interface ExpandedDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  oldValue: string;
  newValue: string;
  /** Optional icon override (defaults to FileCode) */
  icon?: ComponentType<{ className?: string }>;
  /** When true, shows a loading spinner instead of the diff */
  loading?: boolean;
  /** Screen-reader description override */
  description?: string;
  /** List of all files in the review pane for sidebar navigation */
  files?: FileDiffSummary[];
  /** Callback when a file is selected from the sidebar */
  onFileSelect?: (filePath: string) => void;
  /** Cache of loaded diffs keyed by file path */
  diffCache?: Map<string, string>;
  /** File path currently being loaded */
  loadingDiffPath?: string | null;
  /** Checked files set (from ReviewPane) */
  checkedFiles?: Set<string>;
  /** Toggle a file's checked state */
  onToggleFile?: (path: string) => void;
  /** Revert a file */
  onRevertFile?: (path: string) => void;
  /** Add a pattern to .gitignore */
  onIgnore?: (pattern: string) => void;
  /** Base path for constructing absolute file paths (for open-in-editor) */
  basePath?: string;
}

/* ── Diff content (extracted to avoid re-highlighting on sidebar interactions) ── */

/* Stable ID counter for scoping CSS to each DiffContent instance */
let diffScopeCounter = 0;

/**
 * Returns the max natural width (scrollWidth) of the direct child element
 * across all td.left or td.right cells.  The child is the <div>/<ins>/<del>
 * that wraps the line content.
 */
function getMaxChildWidth(container: HTMLElement, side: 'left' | 'right'): number {
  let max = 0;
  for (const td of container.querySelectorAll<HTMLElement>(`td.${side}`)) {
    const child = td.firstElementChild as HTMLElement | null;
    if (child && child.scrollWidth > max) max = child.scrollWidth;
  }
  return max;
}

/**
 * Hook that powers horizontal scroll for split-view diffs.
 *
 * Strategy: the diff table uses table-layout:fixed with equal-width content
 * columns.  Each content <td> has overflow:hidden.  The content <div> inside
 * each <td> is rendered with white-space:pre and width:max-content, so it may
 * be wider than the cell.
 *
 * We translate every content child via `transform: translateX(-Npx)` to
 * simulate scrolling — this works perfectly with overflow:hidden and avoids
 * per-row scrollbars.  Two proxy scrollbar divs (one per pane) at the bottom
 * drive the offset.  Both panes are always synced.
 */
function useSplitDiffProxy(
  containerRef: React.RefObject<HTMLDivElement | null>,
  proxyRef: React.RefObject<HTMLDivElement | null>,
  splitView: boolean,
) {
  useEffect(() => {
    if (!splitView || !containerRef.current || !proxyRef.current) return;
    const container = containerRef.current;
    const proxy = proxyRef.current;

    const translateAll = (offset: number) => {
      const tx = `translateX(${-offset}px)`;
      for (const td of container.querySelectorAll<HTMLElement>('td.left, td.right')) {
        const child = td.firstElementChild as HTMLElement | null;
        if (child) child.style.transform = tx;
      }
    };

    const onProxyScroll = () => {
      translateAll(proxy.scrollLeft);
    };

    const updateSizer = () => {
      const leftW = getMaxChildWidth(container, 'left');
      const rightW = getMaxChildWidth(container, 'right');
      const maxW = Math.max(leftW, rightW);

      const sizer = proxy.firstElementChild as HTMLElement | null;
      if (sizer) sizer.style.width = `${maxW}px`;
    };

    proxy.addEventListener('scroll', onProxyScroll);

    // Run once + re-measure when DOM changes (lazy render, fold/unfold)
    updateSizer();
    const mo = new MutationObserver(updateSizer);
    mo.observe(container, { childList: true, subtree: true });

    const ro = new ResizeObserver(updateSizer);
    ro.observe(container);

    return () => {
      mo.disconnect();
      ro.disconnect();
      proxy.removeEventListener('scroll', onProxyScroll);
      // Reset transforms
      for (const td of container.querySelectorAll<HTMLElement>('td.left, td.right')) {
        const child = td.firstElementChild as HTMLElement | null;
        if (child) child.style.transform = '';
      }
    };
  }, [splitView, containerRef, proxyRef]);
}

function DiffContent({
  oldValue,
  newValue,
  filePath,
  splitView,
  loading,
}: {
  oldValue: string;
  newValue: string;
  filePath: string;
  splitView: boolean;
  loading: boolean;
}) {
  const { renderContent } = useDiffHighlight(oldValue, newValue, filePath);
  const containerRef = useRef<HTMLDivElement>(null);
  const proxyRef = useRef<HTMLDivElement>(null);
  const [scopeId] = useState(() => `diff-scope-${++diffScopeCounter}`);

  useSplitDiffProxy(containerRef, proxyRef, splitView);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="icon-base animate-spin" />
        Loading diff…
      </div>
    );
  }

  if (!oldValue && !newValue) {
    return <p className="p-4 text-xs text-muted-foreground">No diff available</p>;
  }

  return (
    <div ref={containerRef} data-diff-scope={scopeId} className="relative">
      {/* Scoped CSS: equal columns, clip content, no-wrap */}
      {splitView && (
        <style>{`
          [data-diff-scope="${scopeId}"] table {
            table-layout: fixed !important;
            width: 100% !important;
          }
          [data-diff-scope="${scopeId}"] colgroup col:nth-child(3),
          [data-diff-scope="${scopeId}"] colgroup col:nth-child(6) {
            width: calc(50% - 78px) !important;
          }
          [data-diff-scope="${scopeId}"] td.left,
          [data-diff-scope="${scopeId}"] td.right {
            overflow: hidden !important;
            max-width: 0 !important;
          }
          [data-diff-scope="${scopeId}"] td.left > *,
          [data-diff-scope="${scopeId}"] td.right > * {
            white-space: pre !important;
            line-break: auto !important;
            width: max-content !important;
            will-change: transform;
          }
        `}</style>
      )}
      <Suspense fallback={<div className="p-4 text-xs text-muted-foreground">Loading diff…</div>}>
        <ReactDiffViewer
          oldValue={oldValue}
          newValue={newValue}
          splitView={splitView}
          useDarkTheme={true}
          hideLineNumbers={false}
          showDiffOnly={true}
          styles={DIFF_VIEWER_STYLES}
          renderContent={renderContent}
        />
      </Suspense>
      {/* Single proxy scrollbar at the bottom — drives both panes */}
      {splitView && (
        <div className="sticky bottom-0 z-10 flex" style={{ pointerEvents: 'none' }}>
          <div style={{ width: '78px', flexShrink: 0 }} />
          <div
            ref={proxyRef}
            className="overflow-x-auto overflow-y-hidden"
            style={{
              flex: 1,
              height: '14px',
              pointerEvents: 'auto',
              background: 'hsl(var(--background))',
              borderTop: '1px solid hsl(var(--border))',
            }}
            data-testid="diff-scroll-proxy"
          >
            <div style={{ height: '1px' }} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main component ── */

export function ExpandedDiffDialog({
  open,
  onOpenChange,
  filePath,
  oldValue,
  newValue,
  icon: Icon = FileCode,
  loading = false,
  description,
  files,
  onFileSelect,
  checkedFiles,
  onToggleFile,
  onRevertFile,
  onIgnore,
  basePath,
}: ExpandedDiffDialogProps) {
  const [splitView, setSplitView] = useState(true);

  const hasFileSidebar = files && files.length > 0 && onFileSelect;

  const handleFileClick = useCallback(
    (path: string) => {
      onFileSelect?.(path);
    },
    [onFileSelect],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] w-[90vw] max-w-[90vw] flex-col gap-0 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-shrink-0 overflow-hidden border-b border-border px-4 py-3">
          <DialogTitle className="flex min-w-0 items-center gap-2 overflow-hidden font-mono text-sm">
            <Icon className="icon-base flex-shrink-0" />
            <span
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {filePath}
            </span>
          </DialogTitle>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setSplitView((prev) => !prev)}
                className="flex-shrink-0 text-muted-foreground"
                data-testid="diff-toggle-split-view"
              >
                {splitView ? <Rows2 className="icon-base" /> : <Columns2 className="icon-base" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {splitView ? 'Unified view' : 'Split view'}
            </TooltipContent>
          </Tooltip>
          <DialogDescription className="sr-only">
            {description || `Diff for ${getFileName(filePath)}`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          {/* File tree sidebar — shared FileTree component */}
          {hasFileSidebar && (
            <div className="flex w-80 flex-shrink-0 flex-col border-r border-border">
              <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Files
              </div>
              <div className="min-h-0 flex-1">
                <FileTree
                  files={files}
                  selectedFile={filePath}
                  onFileClick={handleFileClick}
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
          )}

          {/* Diff content */}
          <ScrollArea className="min-h-0 flex-1">
            <DiffContent
              oldValue={oldValue}
              newValue={newValue}
              filePath={filePath}
              splitView={splitView}
              loading={loading}
            />
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
