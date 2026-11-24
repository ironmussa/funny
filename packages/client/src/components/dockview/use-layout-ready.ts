import type { DockviewApi, DockviewReadyEvent } from 'dockview-react';
import { type MutableRefObject, type ReactNode, useCallback } from 'react';

import {
  LEFT_EDGE_ID,
  PANEL_BROWSER,
  PANEL_CENTER,
  PANEL_LEFT,
  PANEL_TOP,
  STORAGE_KEY_BOTTOM_HEIGHT,
  STORAGE_KEY_BROWSER_WIDTH,
  STORAGE_KEY_LAYOUT,
  STORAGE_KEY_LEFT_WIDTH,
  STORAGE_KEY_RIGHT_WIDTH,
  TOP_EDGE_ID,
  isBottomPanelId,
  notifyActiveTab,
  readBottomOrder,
  sameOrder,
} from './layout-ids';
import { restoreStoredLayout, writeStoredSize } from './layout-storage';
import { persistRightWidth } from './right-pane';
import { useDebouncedLayoutPersist } from './use-debounced-layout-persist';
import type { LayoutPanelOps } from './use-layout-panel-ops';
import type { LayoutPropRefs } from './use-layout-prop-refs';

type LayoutReadyInput = {
  apiRef: MutableRefObject<DockviewApi | null>;
  refs: LayoutPropRefs;
  ops: LayoutPanelOps;
  top: ReactNode | undefined;
  topHeight: number;
  rightPaneOpen: boolean;
  browser: ReactNode | undefined;
  browserOpen: boolean;
  bottomPaneOpen: boolean;
};

/** Builds or restores DockviewLayout's grid when dockview is ready, and
 *  subscribes to its panel/layout events. Returns the `onReady` handler. */
export function useLayoutReady({
  apiRef,
  refs,
  ops,
  top,
  topHeight,
  rightPaneOpen,
  browser,
  browserOpen,
  bottomPaneOpen,
}: LayoutReadyInput) {
  const {
    initialLeftWidthResolved,
    leftPaneOpenRef,
    activeRightTabRef,
    onActiveRightTabChangeRef,
    activeBottomTabRef,
    onActiveBottomTabChangeRef,
    onBottomTabCloseRef,
    onBrowserCloseRef,
    onBottomTabsReorderRef,
  } = refs;
  const {
    addBrowserPanel,
    addRightPanels,
    hideHeader,
    isAnimatingRef,
    suppressCloseRef,
    syncBottomPanels,
  } = ops;

  /** Build the initial layout from scratch (no saved layout available). */
  const buildDefaultLayout = useCallback(
    (api: DockviewApi) => {
      const centerPanel = api.addPanel({
        id: PANEL_CENTER,
        component: PANEL_CENTER,
        title: 'Main',
      });
      // Left is an EDGE GROUP (structurally outside the inner gridview), so
      // it has `LayoutPriority.Low` built in — proportional redistribution
      // from sibling resizes / removals can't shrink it. Resulting layout:
      //   ┌─────────┬──────────────────────────────────┐
      //   │         │      top-edge (if `top`)         │
      //   │ left-   ├────────────────────────┬─────────┤
      //   │ edge    │       center           │  right  │
      //   │         ├────────────────────────┤         │
      //   │         │       bottom           │         │
      //   └─────────┴────────────────────────┴─────────┘
      // The top edge group is INSIDE the middle column, so it spans across
      // center + right (and bottom if right wraps it), but not over the
      // left sidebar.
      api.addEdgeGroup('left', {
        id: LEFT_EDGE_ID,
        initialSize: initialLeftWidthResolved,
        // 40px keeps a thin rail visible when the sidebar is collapsed so the
        // in-sidebar expand button stays reachable. AppSidebar switches to a
        // rail-only render when its `state === 'collapsed'`.
        collapsedSize: 40,
        collapsed: !leftPaneOpenRef.current,
      });
      const leftPanel = api.addPanel({
        id: PANEL_LEFT,
        component: PANEL_LEFT,
        title: 'Sidebar',
        position: { referenceGroup: LEFT_EDGE_ID, direction: 'within' },
      });
      hideHeader(centerPanel);
      hideHeader(leftPanel);

      // Top edge group — header that spans across center+right area.
      // We explicitly pin minimumSize === maximumSize === initialSize so the
      // edge group is EXACTLY `topHeight` tall. Without this, dockview's
      // default `minimumSize = collapsedSize + 50` would bloat the group
      // (e.g. with our collapsedSize=0 the default min is 50, so the visible
      // group would be 50px instead of the 48px we requested, leaving a
      // ghost strip below the header).
      if (top !== undefined) {
        api.addEdgeGroup('top', {
          id: TOP_EDGE_ID,
          initialSize: topHeight,
          minimumSize: topHeight,
          maximumSize: topHeight,
          collapsedSize: 0,
          collapsed: false,
        });
        const topPanel = api.addPanel({
          id: PANEL_TOP,
          component: PANEL_TOP,
          title: 'Top',
          position: { referenceGroup: TOP_EDGE_ID, direction: 'within' },
        });
        hideHeader(topPanel);
      }

      if (rightPaneOpen) addRightPanels(api);
      if (browserOpen && browser !== undefined) addBrowserPanel(api);
      // Bottom MUST be added AFTER right so the `direction: 'right'` of the
      // right group lands at the root level (next to center column), not
      // inside a center+bottom sub-column. Order matters.
      if (bottomPaneOpen) syncBottomPanels(api);
    },
    [
      addBrowserPanel,
      addRightPanels,
      browser,
      browserOpen,
      bottomPaneOpen,
      hideHeader,
      initialLeftWidthResolved,
      leftPaneOpenRef,
      rightPaneOpen,
      syncBottomPanels,
      top,
      topHeight,
    ],
  );

  /** Minimal-touch reconcile of a restored layout. We:
   *   - sanity-check left+center (corruption guard),
   *   - re-hide left+center headers (defensive on older blobs),
   *   - drop the restored browser panel if the store currently says closed
   *     (its `open` flag is intentionally not persisted across reloads, so
   *     "browser open" must be re-asserted by the user every session).
   *
   *  We deliberately DON'T tear down right/bottom panels even when their
   *  contents don't yet match the props — the app's data is still loading at
   *  mount, and tearing down here would cause a visible flicker
   *  (restored → torn down → re-added once data settles). The sync effects
   *  handle real prop transitions later. */
  const reconcileAfterRestore = useCallback(
    (api: DockviewApi): boolean => {
      if (!api.getPanel(PANEL_LEFT) || !api.getPanel(PANEL_CENTER)) return false;
      // Belt-and-suspenders alongside the storage-version bump: even if the
      // saved blob has the right key version, double-check that the left
      // sidebar actually lives inside the edge group. If it's a regular
      // `direction: 'left'` panel, force a clean rebuild — restoring the
      // old structure loses the priority.Low protection and reintroduces
      // the sidebar-jiggle bug.
      if (!api.getEdgeGroup('left')) return false;
      // Same check for the top edge group when the caller wants a top slot.
      if (top !== undefined && !api.getEdgeGroup('top')) return false;
      // Inverse: if the caller DOESN'T want a top slot, but the saved layout
      // has a stale top edge group OR top panel (e.g. carried over from when
      // the caller used to pass `top`), force a rebuild — otherwise it
      // renders as a headerless empty band above center+right.
      if (top === undefined && (api.getEdgeGroup('top') || api.getPanel(PANEL_TOP))) return false;
      hideHeader(api.getPanel(PANEL_LEFT)!);
      hideHeader(api.getPanel(PANEL_CENTER)!);
      // Reconcile the restored left-edge collapsed state against the prop —
      // the cookie-backed sidebar `open` is the source of truth.
      const leftEdge = api.getEdgeGroup('left');
      if (leftEdge) {
        const want = leftPaneOpenRef.current;
        if (want && leftEdge.isCollapsed()) leftEdge.expand();
        else if (!want && !leftEdge.isCollapsed()) leftEdge.collapse();
      }
      const restoredTopPanel = api.getPanel(PANEL_TOP);
      if (restoredTopPanel) hideHeader(restoredTopPanel);
      // Re-pin the top edge group's height. `addEdgeGroup` sets
      // minimumSize/maximumSize on creation, but those constraints are NOT
      // preserved by `fromJSON` — a saved layout where the splitter was
      // dragged would restore at that wrong height AND stay draggable
      // (since dockview's default min becomes `collapsedSize + 50`). Re-apply
      // the height constraint and reset to topHeight so the header is exactly
      // topHeight tall every reload.
      if (top !== undefined) {
        const topGroup = api.getEdgeGroup('top');
        if (topGroup) {
          topGroup.setConstraints({
            minimumHeight: topHeight,
            maximumHeight: topHeight,
          });
          topGroup.setSize({ height: topHeight });
        }
      }
      if (!browserOpen || browser === undefined) {
        const existingBrowser = api.getPanel(PANEL_BROWSER);
        if (existingBrowser) {
          suppressCloseRef.current.add(PANEL_BROWSER);
          existingBrowser.api.close();
        }
      }
      return true;
    },
    [browser, browserOpen, hideHeader, leftPaneOpenRef, suppressCloseRef, top, topHeight],
  );

  const schedulePersistLayout = useDebouncedLayoutPersist(STORAGE_KEY_LAYOUT);

  // ── onReady: build initial layout + subscribe to events ──
  return useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      // Try to restore the user's full saved layout first. If that fails (or
      // it leaves us in a corrupt state with missing left/center), clear the
      // bad blob and fall back to the default layout. Panels wiped from a
      // partial restore are marked so their close doesn't bounce to the store.
      const restored = restoreStoredLayout(
        event.api,
        STORAGE_KEY_LAYOUT,
        reconcileAfterRestore,
        (panelId) => suppressCloseRef.current.add(panelId),
      );
      if (!restored) {
        buildDefaultLayout(event.api);
      }

      subscribeLayoutEvents(event.api, {
        activeRightTabRef,
        onActiveRightTabChangeRef,
        activeBottomTabRef,
        onActiveBottomTabChangeRef,
        onBottomTabCloseRef,
        onBrowserCloseRef,
        onBottomTabsReorderRef,
        suppressCloseRef,
        isAnimatingRef,
        schedulePersistLayout,
      });
    },
    [
      activeBottomTabRef,
      activeRightTabRef,
      apiRef,
      buildDefaultLayout,
      isAnimatingRef,
      onActiveBottomTabChangeRef,
      onActiveRightTabChangeRef,
      onBottomTabCloseRef,
      onBottomTabsReorderRef,
      onBrowserCloseRef,
      reconcileAfterRestore,
      schedulePersistLayout,
      suppressCloseRef,
    ],
  );
}

type LayoutEventDeps = Pick<
  LayoutPropRefs,
  | 'activeRightTabRef'
  | 'onActiveRightTabChangeRef'
  | 'activeBottomTabRef'
  | 'onActiveBottomTabChangeRef'
  | 'onBottomTabCloseRef'
  | 'onBrowserCloseRef'
  | 'onBottomTabsReorderRef'
> &
  Pick<LayoutPanelOps, 'suppressCloseRef' | 'isAnimatingRef'> & {
    schedulePersistLayout: (api: DockviewApi) => void;
  };

function subscribeLayoutEvents(
  api: DockviewApi,
  {
    activeRightTabRef,
    onActiveRightTabChangeRef,
    activeBottomTabRef,
    onActiveBottomTabChangeRef,
    onBottomTabCloseRef,
    onBrowserCloseRef,
    onBottomTabsReorderRef,
    suppressCloseRef,
    isAnimatingRef,
    schedulePersistLayout,
  }: LayoutEventDeps,
) {
  // Active panel changes → notify the store(s).
  api.onDidActivePanelChange((activePanelEvent) => {
    const panel = activePanelEvent.panel;
    if (!panel) return;
    if (!notifyActiveTab(panel.id, 'right:', activeRightTabRef, onActiveRightTabChangeRef)) {
      notifyActiveTab(panel.id, 'bottom:', activeBottomTabRef, onActiveBottomTabChangeRef);
    }
  });

  // Panel removal — bounce to the corresponding store handler unless WE
  // initiated the close (programmatic sync / open toggle).
  api.onDidRemovePanel((panel) => {
    if (suppressCloseRef.current.has(panel.id)) {
      suppressCloseRef.current.delete(panel.id);
      return;
    }
    if (panel.id.startsWith('bottom:')) {
      const tabId = panel.id.slice('bottom:'.length);
      onBottomTabCloseRef.current?.(tabId);
    } else if (panel.id === PANEL_BROWSER) {
      onBrowserCloseRef.current?.();
    }
  });

  // Tab reorder within the bottom group → notify with the new ordered ids.
  // Dockview doesn't expose a dedicated reorder event; we re-read the
  // group's panels on any layout change and diff against the previous order.
  let lastBottomOrder = readBottomOrder(api);
  api.onDidLayoutChange(() => {
    // While a toggle animation is in flight, skip persistence — the
    // intermediate frame widths/heights would otherwise overwrite the
    // user's real values in localStorage (e.g. animating to 0 would
    // persist a width of 0 for the right pane).
    if (isAnimatingRef.current) return;

    // Persist left/right/browser widths and bottom height (cheap, always)
    const lp = api.getPanel(PANEL_LEFT);
    if (lp) writeStoredSize(STORAGE_KEY_LEFT_WIDTH, lp.group.width);
    persistRightWidth(api, STORAGE_KEY_RIGHT_WIDTH);
    const bp = api.panels.find((p) => isBottomPanelId(p.id));
    if (bp) writeStoredSize(STORAGE_KEY_BOTTOM_HEIGHT, bp.group.height);
    const browserPanel = api.getPanel(PANEL_BROWSER);
    if (browserPanel) {
      writeStoredSize(STORAGE_KEY_BROWSER_WIDTH, browserPanel.group.width);
    }

    // Persist the FULL layout (positions + sizes + active panels) — this
    // is what lets the user's custom arrangement survive a reload.
    schedulePersistLayout(api);

    // Detect bottom-tab reorder.
    const order = readBottomOrder(api);
    if (order.length === lastBottomOrder.length && !sameOrder(order, lastBottomOrder)) {
      onBottomTabsReorderRef.current?.(order);
    }
    lastBottomOrder = order;
  });
}
