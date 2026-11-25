import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { type ReactNode, useCallback, useRef } from 'react';

import { PANEL_RIGHT, closeRightPanels } from '@/lib/dockview-right-panels';

import {
  PANEL_BROWSER,
  PANEL_CENTER,
  STORAGE_KEY_BOTTOM_HEIGHT,
  STORAGE_KEY_BROWSER_WIDTH,
  STORAGE_KEY_RIGHT_WIDTH,
  bottomPanelId,
  isBottomPanelId,
  rightPanelId,
} from './layout-ids';
import { readStoredSize, writeStoredSize } from './layout-storage';
import type { BottomTabSpec } from './types';
import type { LayoutPropRefs } from './use-layout-prop-refs';

/** Imperative add/remove/resize operations on DockviewLayout's right, browser
 *  and bottom panels. */
export function useLayoutPanelOps(refs: LayoutPropRefs, right: ReactNode | undefined) {
  const {
    initialRightWidthRef,
    initialBottomHeightRef,
    initialBrowserWidthRef,
    rightTabsRef,
    activeRightTabRef,
    bottomTabsRef,
    activeBottomTabRef,
    browserTitleRef,
  } = refs;

  // ── Helpers ──
  const hideHeader = useCallback((panel: IDockviewPanel) => {
    panel.group.header.hidden = true;
  }, []);

  // ── Animation state ──
  /** True while a panel toggle animation is running. While true, the
   *  `onDidLayoutChange` persistence write is skipped so intermediate-frame
   *  sizes don't clobber the user's real width in localStorage. */
  const isAnimatingRef = useRef(false);

  // (Previously here: `pinLeftWidth` + `leftPinnedWidthRef`. They captured the
  // left sidebar's width at animation start and restored it on end to undo
  // `Sizing.Distribute` redistribution from `panel.api.close()`. Now that the
  // sidebar lives in an edge group with `LayoutPriority.Low`, the splitview
  // never takes from it in the first place — and calling `setSize` on the
  // panel side actually triggered a spurious shell-level resize that MOVED
  // the sidebar on every toggle. Removed.)

  // ── Right-pane management ──
  const addRightPanels = useCallback(
    (api: DockviewApi, widthOverride?: number) => {
      const desiredWidth =
        widthOverride ?? readStoredSize(STORAGE_KEY_RIGHT_WIDTH) ?? initialRightWidthRef.current;
      const tabs = rightTabsRef.current;
      if (tabs && tabs.length > 0) {
        let firstPanel: IDockviewPanel | null = null;
        for (let i = 0; i < tabs.length; i++) {
          const tab = tabs[i];
          const panel = api.addPanel({
            id: rightPanelId(tab.id),
            component: 'right-tab',
            tabComponent: 'right-tab',
            title: tab.title,
            params: { hostId: rightPanelId(tab.id) },
            position:
              i === 0
                ? // ABSOLUTE 'right' — lands at the root grid edge so the
                  // right group spans full height, even next to the bottom
                  // (terminals) group below center.
                  { direction: 'right' }
                : { direction: 'within', referencePanel: rightPanelId(tabs[0].id) },
            initialWidth: i === 0 ? desiredWidth : undefined,
            renderer: 'always',
          });
          if (i === 0) firstPanel = panel;
        }
        if (firstPanel) {
          const desired = activeRightTabRef.current ?? tabs[0].id;
          const target = api.getPanel(rightPanelId(desired));
          target?.api.setActive();
        }
      } else if (right !== undefined) {
        const panel = api.addPanel({
          id: PANEL_RIGHT,
          component: PANEL_RIGHT,
          title: 'Review',
          position: { direction: 'right' },
          initialWidth: desiredWidth,
        });
        hideHeader(panel);
      }
    },
    [activeRightTabRef, hideHeader, initialRightWidthRef, right, rightTabsRef],
  );

  const removeRightPanels = useCallback((api: DockviewApi) => closeRightPanels(api), []);

  // ── Browser-panel management ──
  /** Add the browser panel to the right of center (between center and right). */
  const addBrowserPanel = useCallback(
    (api: DockviewApi) => {
      return api.addPanel({
        id: PANEL_BROWSER,
        component: PANEL_BROWSER,
        title: browserTitleRef.current,
        // `direction: 'right', referencePanel: 'center'` splits center's column
        // horizontally; since the right group was added with an ABSOLUTE 'right'
        // direction (root level), the new browser panel slots between the center
        // column and the right group → [left | center | browser | right].
        position: { direction: 'right', referencePanel: PANEL_CENTER },
        // Read the stored width, not the mount-time ref: the browser opens per
        // thread, so it is closed and re-added on every thread switch and must
        // come back at the width the user last dragged it to.
        initialWidth: readStoredSize(STORAGE_KEY_BROWSER_WIDTH) ?? initialBrowserWidthRef.current,
      });
    },
    [browserTitleRef, initialBrowserWidthRef],
  );

  /** Panel ids that we're closing programmatically — used to suppress the
   *  `onBottomTabClose` callback so the store doesn't bounce. */
  const suppressCloseRef = useRef<Set<string>>(new Set());

  const removeBrowserPanel = useCallback((api: DockviewApi) => {
    const panel = api.getPanel(PANEL_BROWSER);
    if (!panel) return;
    suppressCloseRef.current.add(PANEL_BROWSER);
    panel.api.close();
  }, []);

  // ── Bottom-pane management ──
  /** Add the FIRST bottom panel (creates the group below center). */
  const addInitialBottomPanel = useCallback(
    (api: DockviewApi, tab: BottomTabSpec, heightOverride?: number) => {
      return api.addPanel({
        id: bottomPanelId(tab.id),
        component: 'bottom-tab',
        title: tab.title,
        params: { hostId: bottomPanelId(tab.id) },
        position: { direction: 'below', referencePanel: PANEL_CENTER },
        // Stored height, not the mount-time ref: the bottom group is removed
        // when the terminal scope has no tabs and re-added on the way back.
        initialHeight:
          heightOverride ??
          readStoredSize(STORAGE_KEY_BOTTOM_HEIGHT) ??
          initialBottomHeightRef.current,
        renderer: 'always',
      });
    },
    [initialBottomHeightRef],
  );

  /** Add a subsequent bottom panel to the existing bottom group. */
  const addBottomTabToGroup = useCallback(
    (api: DockviewApi, tab: BottomTabSpec, anchorId: string) => {
      return api.addPanel({
        id: bottomPanelId(tab.id),
        component: 'bottom-tab',
        title: tab.title,
        params: { hostId: bottomPanelId(tab.id) },
        position: { direction: 'within', referencePanel: anchorId },
        renderer: 'always',
      });
    },
    [],
  );

  const getCurrentBottomHeight = useCallback((api: DockviewApi): number | null => {
    const p = api.panels.find((panel) => isBottomPanelId(panel.id));
    if (!p) return null;
    const h = p.group.height;
    return Number.isFinite(h) && h > 0 ? h : null;
  }, []);

  const collapseBottomPane = useCallback(
    (api: DockviewApi) => {
      const p = api.panels.find((panel) => isBottomPanelId(panel.id));
      if (!p) return;
      const currentHeight = getCurrentBottomHeight(api);
      if (currentHeight) writeStoredSize(STORAGE_KEY_BOTTOM_HEIGHT, currentHeight);
      p.group.api.setConstraints({
        minimumHeight: 0,
        maximumHeight: Number.MAX_SAFE_INTEGER,
      });
      p.api.setSize({ height: 0 });
    },
    [getCurrentBottomHeight],
  );

  const expandBottomPane = useCallback(
    (api: DockviewApi) => {
      const p = api.panels.find((panel) => isBottomPanelId(panel.id));
      if (!p) return;
      const nextHeight =
        readStoredSize(STORAGE_KEY_BOTTOM_HEIGHT) ?? initialBottomHeightRef.current;
      p.group.api.setConstraints({
        minimumHeight: 100,
        maximumHeight: Number.MAX_SAFE_INTEGER,
      });
      p.api.setSize({ height: nextHeight });
    },
    [initialBottomHeightRef],
  );

  const removeBottomPanels = useCallback((api: DockviewApi) => {
    for (const p of api.panels.filter((x) => isBottomPanelId(x.id))) {
      suppressCloseRef.current.add(p.id);
      p.api.close();
    }
  }, []);

  /** Sync dockview's bottom panels to match `bottomTabs` exactly, doing
   *  incremental add/remove so existing tabs (and their xterm state) survive. */
  const syncBottomPanels = useCallback(
    (api: DockviewApi) => {
      const desired = bottomTabsRef.current ?? [];
      const existingIds = new Set(api.panels.filter((p) => isBottomPanelId(p.id)).map((p) => p.id));
      const desiredIds = new Set(desired.map((t) => bottomPanelId(t.id)));

      // Remove panels that are no longer wanted.
      for (const id of existingIds) {
        if (!desiredIds.has(id)) {
          // suppressCloseEvent: avoid bouncing back to the store as a close.
          suppressCloseRef.current.add(id);
          api.getPanel(id)?.api.close();
        }
      }

      // Add panels that are wanted but missing.
      for (const tab of desired) {
        const id = bottomPanelId(tab.id);
        if (!existingIds.has(id)) {
          const anchor = api.panels.find((p) => isBottomPanelId(p.id) && p.id !== id);
          if (anchor) {
            addBottomTabToGroup(api, tab, anchor.id);
          } else {
            addInitialBottomPanel(api, tab);
          }
        }
      }

      // Activate the requested tab.
      const wantedActive = activeBottomTabRef.current;
      if (wantedActive) {
        const target = api.getPanel(bottomPanelId(wantedActive));
        if (target && !target.api.isActive) target.api.setActive();
      }
    },
    [activeBottomTabRef, addBottomTabToGroup, addInitialBottomPanel, bottomTabsRef],
  );

  return {
    hideHeader,
    isAnimatingRef,
    suppressCloseRef,
    addRightPanels,
    removeRightPanels,
    addBrowserPanel,
    removeBrowserPanel,
    collapseBottomPane,
    expandBottomPane,
    removeBottomPanels,
    syncBottomPanels,
  };
}

export type LayoutPanelOps = ReturnType<typeof useLayoutPanelOps>;
