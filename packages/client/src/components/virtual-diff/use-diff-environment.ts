import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

import { ensurePretextLoaded, getCachedPrepared, prepareBatch } from '@/hooks/use-pretext';
import type { DiffLine, DiffViewMode } from '@/lib/diff/types';

/**
 * Environment effects of `VirtualDiff`: word-wrap measurement and pane
 * selection isolation.
 */

/**
 * Container width tracking and pretext warm-up for word-wrap measurement:
 * prepares all diff line texts once wrapping is on.
 */
export function useWordWrapMeasure(
  wordWrap: boolean,
  scrollRef: RefObject<HTMLDivElement | null>,
  lines: DiffLine[],
  monoFont: string,
) {
  const [pretextReady, setPretextReady] = useState(false);
  const [diffContainerWidth, setDiffContainerWidth] = useState(0);

  // ── Container width tracking for pretext word-wrap measurement ──
  useEffect(() => {
    if (!wordWrap) return;
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDiffContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setDiffContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [wordWrap, scrollRef]);

  // ── Pretext warm-up: prepare all diff line texts for word-wrap measurement ──
  useEffect(() => {
    if (!wordWrap) return;
    let cancelled = false;
    ensurePretextLoaded().then(() => {
      if (cancelled) return;
      const toPrepare = lines.flatMap(({ text }) =>
        text.length > 0 && !getCachedPrepared(text, monoFont) ? [text] : [],
      );
      // Deduplicate
      const unique = [...new Set(toPrepare)];
      if (unique.length > 0) {
        prepareBatch(unique, monoFont).then(() => {
          if (!cancelled) setPretextReady(true);
        });
      } else {
        setPretextReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [wordWrap, lines, monoFont]);

  return { pretextReady, diffContainerWidth };
}

/** Pane selection isolation: constrain text selection to a single pane. */
export function usePaneSelectionIsolation(
  viewMode: DiffViewMode,
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (viewMode === 'unified') return;
    const container = scrollRef.current;
    if (!container) return;

    let disabled: HTMLElement[] = [];

    const restore = () => {
      for (const p of disabled) p.style.userSelect = '';
      disabled = [];
    };

    const onMouseDown = (e: MouseEvent) => {
      // Clear the browser selection before restoring panes so the old
      // highlight doesn't flash across all columns.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();

      // Restore previous isolation
      restore();

      const target = e.target as HTMLElement;
      const pane = target.closest('[data-pane]') as HTMLElement | null;
      if (!pane) return;

      // Disable all panes that don't match the clicked one
      const activePaneName = pane.dataset.pane;
      container.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => {
        if (p.dataset.pane !== activePaneName) {
          p.style.userSelect = 'none';
          disabled.push(p);
        }
      });
    };

    // Clicking outside the diff container restores all panes
    const onDocMouseDown = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) restore();
    };

    container.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousedown', onDocMouseDown);
    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousedown', onDocMouseDown);
      restore();
    };
  }, [viewMode, scrollRef]);
}
