import { useState, useCallback, useEffect, useRef } from 'react';

import { api } from '@/lib/api';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { buildSections, buildVirtualRows } from '@/lib/diff/layout';
import { parseUnifiedDiff } from '@/lib/diff/parse';

import { isPathWithin } from './utils';

export interface LoadedFileDiff {
  oldValue?: string;
  newValue?: string;
  rawDiff?: string;
}

/** A diff viewer needs at least one hunk to produce visible rows. */
function hasUnifiedDiffHunk(diff: string | undefined): boolean {
  return !!diff && diff.split('\n').some((line) => line.startsWith('@@'));
}

/**
 * The active entry's diff values: the captured ones, or the live diff once
 * loaded. SDK file-change entries contain paths but no patch content. Resolve
 * only expanded cards, so a long transcript does not issue a diff request for
 * every historical edit.
 */
export function useLiveFileDiff({
  expanded,
  activeEntry,
  diffFilePath,
  threadId,
}: {
  expanded: boolean;
  /** The card's active change entry; its identity re-runs the request check. */
  activeEntry: (LoadedFileDiff & { filePath: string }) | undefined;
  diffFilePath: string | undefined;
  threadId: string | null | undefined;
}) {
  const [loadedDiffs, setLoadedDiffs] = useState<Map<string, LoadedFileDiff>>(() => new Map());
  const requestedDiffPathsRef = useRef(new Set<string>());
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [isDiffUnavailable, setIsDiffUnavailable] = useState(false);
  const [diffRequestVersion, setDiffRequestVersion] = useState(0);
  const loadedDiff = activeEntry ? loadedDiffs.get(activeEntry.filePath) : undefined;
  const filePath = activeEntry?.filePath;
  const oldString = loadedDiff?.oldValue ?? activeEntry?.oldValue;
  const newString = loadedDiff?.newValue ?? activeEntry?.newValue;
  const rawDiff = loadedDiff?.rawDiff ?? activeEntry?.rawDiff;
  const hasCapturedDiff = hasUnifiedDiffHunk(rawDiff);

  useEffect(() => {
    const needsLiveDiff = !hasCapturedDiff && (oldString == null || newString == null || !!rawDiff);
    if (!expanded || !activeEntry || !filePath || !diffFilePath || !needsLiveDiff) return;
    if (!threadId || requestedDiffPathsRef.current.has(filePath)) return;

    requestedDiffPathsRef.current.add(filePath);
    setIsDiffLoading(true);
    setIsDiffUnavailable(false);
    let cancelled = false;
    api.getFileDiff(threadId, diffFilePath, false, undefined, 'full').then(
      (result) => {
        const rawDiff = result.isOk() ? result.value.diff : '';
        const hasUsableDiff = hasUnifiedDiffHunk(rawDiff);
        if (!cancelled && hasUsableDiff) {
          setLoadedDiffs((current) => {
            const next = new Map(current);
            next.set(filePath, {
              oldValue: parseDiffOld(rawDiff),
              newValue: parseDiffNew(rawDiff),
              rawDiff,
            });
            return next;
          });
        }
        if (!cancelled) {
          setIsDiffUnavailable(!hasUsableDiff);
          setIsDiffLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setIsDiffUnavailable(true);
          setIsDiffLoading(false);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [
    activeEntry,
    diffFilePath,
    diffRequestVersion,
    expanded,
    filePath,
    hasCapturedDiff,
    newString,
    oldString,
    rawDiff,
    threadId,
  ]);

  const retryDiff = useCallback((path: string) => {
    requestedDiffPathsRef.current.delete(path);
    setDiffRequestVersion((version) => version + 1);
  }, []);

  return {
    oldString,
    newString,
    rawDiff,
    hasCapturedDiff,
    isDiffLoading,
    isDiffUnavailable,
    retryDiff,
  };
}

/**
 * `snippetBaseLine` only feeds the rendered diff (computeUnifiedDiff /
 * baseLine prop), which itself is gated behind `diffMounted`. Reading the
 * file on mount for *every* card floods `/files/read` when a transcript has
 * hundreds of Edit/Write cards (e.g. an imported Claude Code session). Gate
 * the read on `diffMounted` so only cards whose diff is actually on-screen
 * fetch the file.
 */
export function useSnippetBaseLine({
  diffMounted,
  rawDiff,
  filePath,
  newString,
  projectPath,
}: {
  diffMounted: boolean;
  rawDiff: string | undefined;
  filePath: string | undefined;
  newString: string | undefined;
  projectPath: string | undefined;
}) {
  const [snippetBaseLine, setSnippetBaseLine] = useState<number>(1);
  useEffect(() => {
    if (!diffMounted) return;
    if (rawDiff) return;
    if (!filePath || newString == null) return;
    // The runtime only serves files inside the thread's project/worktree; a
    // read outside it (e.g. `/tmp` scripts, Claude memory files) is a
    // guaranteed 403 that only adds console noise. Scratch threads have no
    // client-side base path, so they keep trying.
    if (projectPath && !isPathWithin(filePath, projectPath)) return;
    let cancelled = false;
    api.readFile(filePath).then((result) => {
      if (cancelled || result.isErr()) return;
      const content = result.value.content;
      const idx = content.indexOf(newString);
      if (idx < 0) return;
      const baseLine = content.slice(0, idx).split('\n').length;
      setSnippetBaseLine(baseLine);
    });
    return () => {
      cancelled = true;
    };
  }, [diffMounted, filePath, newString, projectPath, rawDiff]);
  return snippetBaseLine;
}

/**
 * Mounts the inline diff only once its slot is near the viewport. Returns
 * whether it is mounted and the callback ref for the slot element.
 */
export function useDiffMountOnVisible(expanded: boolean) {
  const [diffMounted, setDiffMounted] = useState(false);
  const diffObserverRef = useRef<IntersectionObserver | null>(null);
  const diffMountFrameRef = useRef<number | null>(null);

  const diffSlotRef = useCallback(
    (el: HTMLDivElement | null) => {
      diffObserverRef.current?.disconnect();
      diffObserverRef.current = null;
      if (diffMountFrameRef.current != null) {
        window.cancelAnimationFrame(diffMountFrameRef.current);
        diffMountFrameRef.current = null;
      }

      if (!el || !expanded || diffMounted) return;
      if (typeof IntersectionObserver === 'undefined') {
        setDiffMounted(true);
        return;
      }

      // IntersectionObserver can miss a newly expanded element inside the
      // transcript's nested scroller. Check its viewport position on the next
      // frame as a fallback so the card cannot remain a blank placeholder.
      diffMountFrameRef.current = window.requestAnimationFrame(() => {
        diffMountFrameRef.current = null;
        const rect = el.getBoundingClientRect();
        const withinViewportMargin =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom >= -600 &&
          rect.top <= window.innerHeight + 600;
        if (withinViewportMargin) setDiffMounted(true);
      });

      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setDiffMounted(true);
            io.disconnect();
          }
        },
        { rootMargin: '600px 0px' },
      );
      diffObserverRef.current = io;
      // The observer is disconnected on intersection, callback-ref replacement, and component unmount.
      // react-doctor-disable-next-line effect-needs-cleanup
      io.observe(el);
    },
    [diffMounted, expanded],
  );

  useEffect(
    () => () => {
      diffObserverRef.current?.disconnect();
      if (diffMountFrameRef.current != null) {
        window.cancelAnimationFrame(diffMountFrameRef.current);
      }
    },
    [],
  );

  return { diffMounted, diffSlotRef };
}

/**
 * Height reserved for the inline diff. VirtualDiff folds long unchanged
 * sections by default, so this counts the rows it actually renders, not every
 * line in the raw patch; otherwise a small edit in a large hunk leaves a tall
 * empty panel below the diff.
 */
export function computeInlineDiffSlotHeight(
  unifiedDiff: string,
  rowHeight: number,
  contextLines: number,
): number {
  const parsedDiff = parseUnifiedDiff(unifiedDiff);
  const sections = buildSections(parsedDiff.lines, contextLines);
  const visibleRows = buildVirtualRows(
    sections,
    parsedDiff.lines,
    parsedDiff.hunkHeaders,
    contextLines,
  );
  const conflictStartLines = new Set(parsedDiff.conflictBlocks.map((block) => block.startLineIdx));
  const visibleConflictActions = visibleRows.filter(
    (row) => row.type === 'line' && conflictStartLines.has(row.lineIdx),
  ).length;
  const visibleRowCount = visibleRows.length + visibleConflictActions;
  return Math.max(64, visibleRowCount * rowHeight);
}
