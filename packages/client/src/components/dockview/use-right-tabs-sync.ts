import type { DockviewApi } from 'dockview-react';
import { type MutableRefObject, type ReactNode, useEffect, useRef } from 'react';

import { PANEL_RIGHT, isRightPanelId } from '@/lib/dockview-right-panels';

import { rightPanelId, sameSet } from './layout-ids';
import { getCurrentRightWidth } from './right-pane';
import type { RightTabSpec } from './types';

type RightTabsSyncInput = {
  apiRef: MutableRefObject<DockviewApi | null>;
  rightTabsRef: MutableRefObject<RightTabSpec[] | undefined>;
  right: ReactNode | undefined;
  rightTabs: RightTabSpec[] | undefined;
  activeRightTab: string | undefined;
  isTabbedRight: boolean;
  rightPaneOpen: boolean;
  addRightPanels: (api: DockviewApi, widthOverride?: number) => void;
  removeRightPanels: (api: DockviewApi) => void;
};

function expectedRightPanelIds(
  tabs: RightTabSpec[] | undefined,
  right: ReactNode | undefined,
): string[] {
  if (tabs && tabs.length > 0) return tabs.map((t) => rightPanelId(t.id));
  return right !== undefined ? [PANEL_RIGHT] : [];
}

/** Activates the requested right tab, and rebuilds the right panels when the
 *  set of tabs (ids + titles) changes. */
export function useRightTabsSync({
  apiRef,
  rightTabsRef,
  right,
  rightTabs,
  activeRightTab,
  isTabbedRight,
  rightPaneOpen,
  addRightPanels,
  removeRightPanels,
}: RightTabsSyncInput) {
  useEffect(() => {
    if (!isTabbedRight || !activeRightTab) return;
    const api = apiRef.current;
    if (!api) return;
    const panel = api.getPanel(rightPanelId(activeRightTab));
    if (panel && !panel.api.isActive) panel.api.setActive();
  }, [activeRightTab, apiRef, isTabbedRight]);

  const rightTabsSig = (rightTabs ?? []).map((t) => `${t.id}|${t.title}`).join(',');
  const lastSyncedRightSigRef = useRef<string | null>(null);
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (!rightPaneOpen) return;
    if (lastSyncedRightSigRef.current === null) {
      // On first run, *seed* the tracker with whatever's on screen (which may
      // be a layout restored from JSON). This prevents the next prop change
      // from being mis-interpreted as a transition.
      lastSyncedRightSigRef.current = rightTabsSig;
      return;
    }
    if (lastSyncedRightSigRef.current === rightTabsSig) return;
    lastSyncedRightSigRef.current = rightTabsSig;

    // Skip rebuild if dockview already has the panels the new sig wants — this
    // covers the case where the saved layout already matches the eventual prop
    // state (e.g. the user was in review mode last session and lands back in
    // review mode after data loads).
    const expectedIds = expectedRightPanelIds(rightTabsRef.current, right);
    const existingIds = api.panels.filter((p) => isRightPanelId(p.id)).map((p) => p.id);
    if (sameSet(existingIds, expectedIds)) return;

    const currentWidth = getCurrentRightWidth(api);
    removeRightPanels(api);
    addRightPanels(api, currentWidth ?? undefined);
  }, [rightTabsSig, rightPaneOpen, right, addRightPanels, removeRightPanels, apiRef, rightTabsRef]);
}
