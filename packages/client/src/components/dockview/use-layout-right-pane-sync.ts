import type { DockviewApi } from 'dockview-react';
import { type MutableRefObject, type ReactNode, useCallback } from 'react';

import { STORAGE_KEY_RIGHT_WIDTH } from './layout-ids';
import { readStoredSize } from './layout-storage';
import {
  getCurrentRightWidth,
  relaxRightMinWidth,
  rightPaneExists,
  setRightPaneSize,
} from './right-pane';
import type { RightTabSpec } from './types';
import { useAnimatedPanelToggle } from './use-animated-panel-toggle';
import type { LayoutPanelOps } from './use-layout-panel-ops';
import type { LayoutPropRefs } from './use-layout-prop-refs';
import { useRightTabsSync } from './use-right-tabs-sync';

type RightPaneSyncInput = {
  apiRef: MutableRefObject<DockviewApi | null>;
  refs: LayoutPropRefs;
  ops: LayoutPanelOps;
  right: ReactNode | undefined;
  rightTabs: RightTabSpec[] | undefined;
  activeRightTab: string | undefined;
  isTabbedRight: boolean;
  rightPaneOpen: boolean;
};

/** Keeps DockviewLayout's right pane in step with its props: animated
 *  open/close, the active tab, and the set of tabs. */
export function useLayoutRightPaneSync({
  apiRef,
  refs,
  ops,
  right,
  rightTabs,
  activeRightTab,
  isTabbedRight,
  rightPaneOpen,
}: RightPaneSyncInput) {
  const { initialRightWidthRef, rightTabsRef } = refs;
  const { addRightPanels, removeRightPanels, isAnimatingRef } = ops;

  // ── Right-pane effects ──
  /** Animated open/close of the right pane. Drives `setSize` frame-by-frame
   *  from current → 0 (close) or 1 → persisted-width (open), then removes
   *  panels on close. While animating, `onRightAnimating` suppresses
   *  layout persistence and pins the left sidebar so it doesn't "breathe"
   *  as proportional space is redistributed. */
  const getRightOpenSize = useCallback(() => {
    // Prefer the freshly-persisted value over the mount-time ref — honors a
    // mid-session drag if the user closes and reopens within the same session.
    return readStoredSize(STORAGE_KEY_RIGHT_WIDTH) ?? initialRightWidthRef.current;
  }, [initialRightWidthRef]);
  const onRightAnimating = useCallback(
    (animating: boolean, api: DockviewApi) => {
      isAnimatingRef.current = animating;
      relaxRightMinWidth(api, animating);
    },
    [isAnimatingRef],
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
  });

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
