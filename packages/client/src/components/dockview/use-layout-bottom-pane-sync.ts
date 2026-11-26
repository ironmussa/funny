import type { DockviewApi } from 'dockview-react';
import { type MutableRefObject, useEffect, useRef } from 'react';

import {
  PANEL_CENTER,
  STORAGE_KEY_BOTTOM_HEIGHT,
  bottomPanelId,
  isBottomPanelId,
} from './layout-ids';
import { readStoredSize } from './layout-storage';
import type { BottomTabSpec } from './types';
import type { LayoutPanelOps } from './use-layout-panel-ops';
import type { LayoutPropRefs } from './use-layout-prop-refs';

type BottomPaneSyncInput = {
  apiRef: MutableRefObject<DockviewApi | null>;
  refs: LayoutPropRefs;
  ops: LayoutPanelOps;
  bottomTabs: BottomTabSpec[] | undefined;
  activeBottomTab: string | undefined;
  bottomPaneOpen: boolean;
};

/** Keeps DockviewLayout's bottom (terminal) group in step with its props:
 *  open/collapse, popout/re-dock, the set of tabs, and the active tab. */
export function useLayoutBottomPaneSync({
  apiRef,
  refs,
  ops,
  bottomTabs,
  activeBottomTab,
  bottomPaneOpen,
}: BottomPaneSyncInput) {
  const { bottomTabsRef, initialBottomHeightRef } = refs;
  const { collapseBottomPane, expandBottomPane, removeBottomPanels, syncBottomPanels } = ops;

  // ── Bottom-pane effects ──
  // Keep bottom panels mounted when the pane is hidden but still has tabs.
  // Closing the panels destroys dockview's nested terminal layout, so hide
  // terminal groups by collapsing their height and only remove them when the
  // current terminal scope has no tabs to render.
  // This must react to the prop because dockview owns the imperative panel tree.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const hasBottom = api.panels.some((p) => isBottomPanelId(p.id));
    const hasDesiredTabs = (bottomTabsRef.current?.length ?? 0) > 0;
    if (bottomPaneOpen && !hasBottom) {
      syncBottomPanels(api);
    } else if (bottomPaneOpen && hasBottom) {
      expandBottomPane(api);
    } else if (!bottomPaneOpen && hasBottom && hasDesiredTabs) {
      collapseBottomPane(api);
    } else if (!bottomPaneOpen && hasBottom) {
      removeBottomPanels(api);
    }
  }, [
    apiRef,
    bottomPaneOpen,
    bottomTabsRef,
    collapseBottomPane,
    expandBottomPane,
    removeBottomPanels,
    syncBottomPanels,
  ]);

  // ── Popout / re-dock a bottom panel via a window event ──
  // The TerminalDockview's "Detach" button dispatches `dockview:popout-bottom`
  // with the tab id; we move that panel into a real OS browser window
  // (`addPopoutGroup`) — or back into the bottom group if it's already popped
  // out. Dockview's PopoutWindow auto-copies the parent document's stylesheets,
  // so Tailwind / shadcn / xterm styles work unchanged in the new window.
  // Decoupling via custom event keeps the action button free of dockview-API
  // plumbing.
  useEffect(() => {
    const handler = (e: Event) => {
      // SAFETY: the only dispatcher, TerminalDockview, sends a CustomEvent whose
      // detail is `{ tabId }`; the optional chain below still tolerates a missing detail.
      const detail = (e as CustomEvent<{ tabId: string }>).detail;
      const tabId = detail?.tabId;
      if (!tabId) return;
      const api = apiRef.current;
      if (!api) return;
      togglePopoutBottomPanel(api, tabId, initialBottomHeightRef.current);
    };
    window.addEventListener('dockview:popout-bottom', handler);
    return () => window.removeEventListener('dockview:popout-bottom', handler);
  }, [apiRef, initialBottomHeightRef]);

  // Sync bottom tabs whenever the desired set or titles change.
  const bottomTabsSig = (bottomTabs ?? []).map((t) => `${t.id}|${t.title}`).join(',');
  const lastSyncedBottomSigRef = useRef<string | null>(null);
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (!bottomPaneOpen) return;
    if (lastSyncedBottomSigRef.current === null) {
      lastSyncedBottomSigRef.current = bottomTabsSig;
      return;
    }
    if (lastSyncedBottomSigRef.current === bottomTabsSig) return;
    lastSyncedBottomSigRef.current = bottomTabsSig;
    syncBottomPanels(api);
  }, [apiRef, bottomTabsSig, bottomPaneOpen, syncBottomPanels]);

  useEffect(() => {
    if (!activeBottomTab) return;
    const api = apiRef.current;
    if (!api) return;
    const panel = api.getPanel(bottomPanelId(activeBottomTab));
    if (panel && !panel.api.isActive) panel.api.setActive();
  }, [activeBottomTab, apiRef]);
}

/** Moves a bottom panel into its own OS window, or re-docks it if it is
 *  already popped out. */
function togglePopoutBottomPanel(api: DockviewApi, tabId: string, initialBottomHeight: number) {
  const panel = api.getPanel(bottomPanelId(tabId));
  if (!panel) return;
  if (panel.group.api.location.type === 'popout') {
    // Re-dock: drop the panel into an existing bottom group if there is
    // one, otherwise create a new bottom group below center. Dockview
    // closes the now-empty popout window automatically.
    const anchor = api.panels.find(
      (p) => isBottomPanelId(p.id) && p.id !== panel.id && p.group.api.location.type === 'grid',
    );
    if (anchor) {
      panel.api.moveTo({ group: anchor.group });
    } else {
      panel.api.moveTo({
        group: api.addGroup({
          direction: 'below',
          referencePanel: PANEL_CENTER,
          initialHeight: readStoredSize(STORAGE_KEY_BOTTOM_HEIGHT) ?? initialBottomHeight,
        }),
      });
    }
  } else {
    // Opens a new OS browser window. The popout inherits the parent's
    // styles via dockview's internal style-cloning; React's createPortal
    // keeps the panel mounted in the parent tree so stores / WS / xterm
    // state survives unchanged.
    void api.addPopoutGroup(panel, {
      position: {
        width: 720,
        height: Math.max(readStoredSize(STORAGE_KEY_BOTTOM_HEIGHT) ?? initialBottomHeight, 360),
        left: window.screenX + 80,
        top: window.screenY + 80,
      },
    });
  }
}
