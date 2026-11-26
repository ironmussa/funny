import type { DockviewApi } from 'dockview-react';
import { type MutableRefObject, type ReactNode, useCallback } from 'react';

import { readStoredSize } from './layout-storage';
import {
  getCurrentRightWidth,
  relaxRightMinWidth,
  rightPaneExists,
  setRightPaneSize,
} from './right-pane';
import type { RightTabSpec } from './types';
import { useAnimatedPanelToggle } from './use-animated-panel-toggle';
import {
  CENTER_STORAGE_KEY_RIGHT_WIDTH,
  type CenterRightPanelOps,
} from './use-center-right-panel-ops';
import { useRightTabsSync } from './use-right-tabs-sync';

type CenterRightPaneSyncInput = {
  apiRef: MutableRefObject<DockviewApi | null>;
  ops: CenterRightPanelOps;
  initialRightWidthRef: MutableRefObject<number>;
  rightTabsRef: MutableRefObject<RightTabSpec[] | undefined>;
  schedulePersistLayout: (api: DockviewApi) => void;
  right: ReactNode | undefined;
  rightTabs: RightTabSpec[] | undefined;
  activeRightTab: string | undefined;
  isTabbedRight: boolean;
  rightPaneOpen: boolean;
};

/** Keeps CenterDockview's right pane in step with its props: open/close, the
 *  active tab, and the set of tabs. */
export function useCenterRightPaneSync({
  apiRef,
  ops,
  initialRightWidthRef,
  rightTabsRef,
  schedulePersistLayout,
  right,
  rightTabs,
  activeRightTab,
  isTabbedRight,
  rightPaneOpen,
}: CenterRightPaneSyncInput) {
  const { isAnimatingRef, addRightPanels, removeRightPanels } = ops;

  // Animated right-pane toggle (mirrors DockviewLayout's animation).
  const getRightOpenSize = useCallback(() => {
    const stored = readStoredSize(CENTER_STORAGE_KEY_RIGHT_WIDTH);
    return stored ?? initialRightWidthRef.current;
  }, [initialRightWidthRef]);
  const onRightAnimating = useCallback(
    (animating: boolean, api: DockviewApi) => {
      isAnimatingRef.current = animating;
      if (!animating) {
        // The close path removes the right panels while `isAnimatingRef` is
        // still true, so the onDidLayoutChange persister skips that change —
        // without this explicit persist the stored layout keeps the right
        // panels forever and every reload restores a pane the open flag says
        // is closed (see the reconcile in onReady).
        schedulePersistLayout(api);
      }
      relaxRightMinWidth(api, animating);
    },
    [isAnimatingRef, schedulePersistLayout],
  );
  useAnimatedPanelToggle({
    apiRef,
    open: rightPaneOpen,
    exists: rightPaneExists,
    getSize: getCurrentRightWidth,
    setSize: setRightPaneSize,
    addPanels: addRightPanels,
    removePanels: removeRightPanels,
    getOpenSize: getRightOpenSize,
    onAnimating: onRightAnimating,
    // Review pane opens/closes instantly — no slide animation.
    duration: 0,
  });

  // Re-sync right panel set when tabs prop changes.
  useRightTabsSync({
    apiRef,
    rightTabsRef,
    right,
    rightTabs,
    activeRightTab,
    isTabbedRight,
    rightPaneOpen,
    addRightPanels,
    removeRightPanels,
  });
}
