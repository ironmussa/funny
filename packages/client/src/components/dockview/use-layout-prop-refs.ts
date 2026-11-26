import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  STORAGE_KEY_BOTTOM_HEIGHT,
  STORAGE_KEY_BROWSER_WIDTH,
  STORAGE_KEY_LEFT_WIDTH,
  STORAGE_KEY_RIGHT_WIDTH,
} from './layout-ids';
import { readStoredSize } from './layout-storage';
import type { BottomTabSpec, RightTabSpec } from './types';

type LayoutPropRefsInput = {
  rightTabs?: RightTabSpec[];
  activeRightTab?: string;
  onActiveRightTabChange?: (id: string) => void;
  bottomTabs?: BottomTabSpec[];
  activeBottomTab?: string;
  onActiveBottomTabChange?: (id: string) => void;
  onBottomTabClose?: (id: string) => void;
  onBottomTabsReorder?: (orderedIds: string[]) => void;
  leftPaneOpen: boolean;
  bottomPrefixActions?: ReactNode;
  bottomLeftActions?: ReactNode;
  bottomRightActions?: ReactNode;
  browserTitle: string;
  onBrowserClose?: () => void;
  initialLeftWidth: number;
  initialRightWidth: number;
  initialBottomHeight: number;
  initialBrowserWidth: number;
};

type SizeDefaults = Pick<
  LayoutPropRefsInput,
  'initialLeftWidth' | 'initialRightWidth' | 'initialBottomHeight' | 'initialBrowserWidth'
>;

type StoredSizes = Record<
  'leftWidth' | 'rightWidth' | 'bottomHeight' | 'browserWidth',
  number | null
>;

/** A stored size wins over the prop default. */
function resolveInitialSizes(stored: StoredSizes, defaults: SizeDefaults) {
  return {
    left: stored.leftWidth ?? defaults.initialLeftWidth,
    right: stored.rightWidth ?? defaults.initialRightWidth,
    bottom: stored.bottomHeight ?? defaults.initialBottomHeight,
    browser: stored.browserWidth ?? defaults.initialBrowserWidth,
  };
}

/** Stored sizes, loaded once on mount, resolved against the prop defaults. */
function useInitialSizeRefs({
  initialLeftWidth,
  initialRightWidth,
  initialBottomHeight,
  initialBrowserWidth,
}: SizeDefaults) {
  // ── Persistence: load stored sizes once on mount ──
  const [stored] = useState(() => ({
    leftWidth: readStoredSize(STORAGE_KEY_LEFT_WIDTH),
    rightWidth: readStoredSize(STORAGE_KEY_RIGHT_WIDTH),
    bottomHeight: readStoredSize(STORAGE_KEY_BOTTOM_HEIGHT),
    browserWidth: readStoredSize(STORAGE_KEY_BROWSER_WIDTH),
  }));
  const initialSizes = resolveInitialSizes(stored, {
    initialLeftWidth,
    initialRightWidth,
    initialBottomHeight,
    initialBrowserWidth,
  });
  const initialRightWidthRef = useRef(initialSizes.right);
  const initialBottomHeightRef = useRef(initialSizes.bottom);
  const initialBrowserWidthRef = useRef(initialSizes.browser);
  useLayoutEffect(() => {
    const sizes = resolveInitialSizes(stored, {
      initialLeftWidth,
      initialRightWidth,
      initialBottomHeight,
      initialBrowserWidth,
    });
    initialRightWidthRef.current = sizes.right;
    initialBottomHeightRef.current = sizes.bottom;
    initialBrowserWidthRef.current = sizes.browser;
  }, [initialBottomHeight, initialBrowserWidth, initialLeftWidth, initialRightWidth, stored]);

  return {
    initialRightWidthRef,
    initialBottomHeightRef,
    initialBrowserWidthRef,
    initialLeftWidthResolved: initialSizes.left,
  };
}

/** Latest right-pane, browser and left-pane props. */
function useRightAndBrowserPropRefs({
  rightTabs,
  activeRightTab,
  onActiveRightTabChange,
  leftPaneOpen,
  browserTitle,
  onBrowserClose,
}: Pick<
  LayoutPropRefsInput,
  | 'rightTabs'
  | 'activeRightTab'
  | 'onActiveRightTabChange'
  | 'leftPaneOpen'
  | 'browserTitle'
  | 'onBrowserClose'
>) {
  const rightTabsRef = useRef(rightTabs);
  const onActiveRightTabChangeRef = useRef(onActiveRightTabChange);
  const activeRightTabRef = useRef(activeRightTab);
  const onBrowserCloseRef = useRef(onBrowserClose);
  const leftPaneOpenRef = useRef(leftPaneOpen);
  const browserTitleRef = useRef(browserTitle);
  useLayoutEffect(() => {
    rightTabsRef.current = rightTabs;
    onActiveRightTabChangeRef.current = onActiveRightTabChange;
    activeRightTabRef.current = activeRightTab;
    onBrowserCloseRef.current = onBrowserClose;
    leftPaneOpenRef.current = leftPaneOpen;
    browserTitleRef.current = browserTitle;
  }, [
    activeRightTab,
    browserTitle,
    leftPaneOpen,
    onActiveRightTabChange,
    onBrowserClose,
    rightTabs,
  ]);
  return {
    rightTabsRef,
    onActiveRightTabChangeRef,
    activeRightTabRef,
    onBrowserCloseRef,
    leftPaneOpenRef,
    browserTitleRef,
  };
}

/** Latest bottom-group props, and its header actions read through refs. */
function useBottomPropRefs({
  bottomTabs,
  activeBottomTab,
  onActiveBottomTabChange,
  onBottomTabClose,
  onBottomTabsReorder,
  bottomPrefixActions,
  bottomLeftActions,
  bottomRightActions,
}: Pick<
  LayoutPropRefsInput,
  | 'bottomTabs'
  | 'activeBottomTab'
  | 'onActiveBottomTabChange'
  | 'onBottomTabClose'
  | 'onBottomTabsReorder'
  | 'bottomPrefixActions'
  | 'bottomLeftActions'
  | 'bottomRightActions'
>) {
  const bottomTabsRef = useRef(bottomTabs);
  const onActiveBottomTabChangeRef = useRef(onActiveBottomTabChange);
  const onBottomTabCloseRef = useRef(onBottomTabClose);
  const onBottomTabsReorderRef = useRef(onBottomTabsReorder);
  const activeBottomTabRef = useRef(activeBottomTab);

  // Bottom header action components are rendered globally by dockview; we read
  // their JSX at render time via refs so the renderer functions stay stable.
  const bottomPrefixActionsRef = useRef(bottomPrefixActions);
  const bottomLeftActionsRef = useRef(bottomLeftActions);
  const bottomRightActionsRef = useRef(bottomRightActions);
  useLayoutEffect(() => {
    bottomTabsRef.current = bottomTabs;
    onActiveBottomTabChangeRef.current = onActiveBottomTabChange;
    onBottomTabCloseRef.current = onBottomTabClose;
    onBottomTabsReorderRef.current = onBottomTabsReorder;
    activeBottomTabRef.current = activeBottomTab;
    bottomPrefixActionsRef.current = bottomPrefixActions;
    bottomLeftActionsRef.current = bottomLeftActions;
    bottomRightActionsRef.current = bottomRightActions;
  }, [
    activeBottomTab,
    bottomLeftActions,
    bottomPrefixActions,
    bottomRightActions,
    bottomTabs,
    onActiveBottomTabChange,
    onBottomTabClose,
    onBottomTabsReorder,
  ]);
  const bottomHeaderActions = useMemo(
    () => ({
      prefix: bottomPrefixActionsRef,
      left: bottomLeftActionsRef,
      right: bottomRightActionsRef,
    }),
    [],
  );
  return {
    bottomTabsRef,
    onActiveBottomTabChangeRef,
    onBottomTabCloseRef,
    onBottomTabsReorderRef,
    activeBottomTabRef,
    bottomHeaderActions,
  };
}

/**
 * Stored sizes (read once on mount) and latest-prop refs for DockviewLayout,
 * so its callbacks/effects don't need to re-create when a prop changes.
 */
export function useLayoutPropRefs(props: LayoutPropRefsInput) {
  const sizes = useInitialSizeRefs(props);
  const rightAndBrowser = useRightAndBrowserPropRefs(props);
  const bottom = useBottomPropRefs(props);
  return { ...sizes, ...rightAndBrowser, ...bottom };
}

export type LayoutPropRefs = ReturnType<typeof useLayoutPropRefs>;
