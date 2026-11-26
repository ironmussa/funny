import { type DockviewApi, DockviewReact } from 'dockview-react';
import { useTheme } from 'next-themes';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { PANEL_RIGHT } from '@/lib/dockview-right-panels';
import 'dockview-react/dist/styles/dockview.css';

import {
  BottomHeaderActionsProvider,
  LeftHeaderActions,
  PrefixHeaderActions,
  RightHeaderActions,
} from './dockview/BottomHeaderActions';
import {
  PANEL_BROWSER,
  PANEL_CENTER,
  PANEL_LEFT,
  PANEL_TOP,
  STORAGE_KEY_LEFT_WIDTH,
  bottomPanelId,
  rightPanelId,
} from './dockview/layout-ids';
import { dockviewThemeFor } from './dockview/theme';
import type { BottomTabSpec, RightTabSpec } from './dockview/types';
import { useLayoutBottomPaneSync } from './dockview/use-layout-bottom-pane-sync';
import { useLayoutPanelOps } from './dockview/use-layout-panel-ops';
import { useLayoutPropRefs } from './dockview/use-layout-prop-refs';
import { useLayoutReady } from './dockview/use-layout-ready';
import { useLayoutRightPaneSync } from './dockview/use-layout-right-pane-sync';
import { useLeftPaneSync } from './dockview/use-left-pane-sync';
import { type LeftWidthMode, useLeftWidthMode } from './dockview/use-left-width-mode';
import { usePanelHosts } from './dockview/use-panel-hosts';

type DockviewLayoutProps = {
  left: ReactNode;
  center: ReactNode;
  /** Top slot — rendered inside a dockview edge group docked to the top of
   *  the shell's middle column, so it spans the full width across center +
   *  right pane (but NOT over the left sidebar, which is its own edge
   *  group). Pass undefined to skip creating the edge group entirely. */
  top?: ReactNode;
  /** Height of the top edge group in px. Default 48 to match a typical
   *  app header (h-12). */
  topHeight?: number;
  /** Single right slot — only used when `rightTabs` is not provided. */
  right?: ReactNode;
  /** Multi-tab right group (fixed set, headers visible, no close on tabs). */
  rightTabs?: RightTabSpec[];
  activeRightTab?: string;
  onActiveRightTabChange?: (id: string) => void;
  rightPaneOpen?: boolean;
  /** Dynamic tab group docked below center (e.g. terminals).
   *  Each tab is closeable via dockview's native X. */
  bottomTabs?: BottomTabSpec[];
  activeBottomTab?: string;
  onActiveBottomTabChange?: (id: string) => void;
  /** User clicked the tab's native X (or programmatic close). */
  onBottomTabClose?: (id: string) => void;
  /** User dragged tabs to reorder — receives the new ordered ids. */
  onBottomTabsReorder?: (orderedIds: string[]) => void;
  bottomPaneOpen?: boolean;
  /** Whether the left sidebar edge group is expanded. Defaults to true.
   *  Flipping collapses/expands the left edge group in place. */
  leftPaneOpen?: boolean;
  /** Custom React node rendered at the far left of the bottom group's header,
   *  before the tabs. */
  bottomPrefixActions?: ReactNode;
  /** Custom React node rendered immediately after the tabs (between tabs and
   *  the right-corner actions). Good place for a "+ new terminal" button. */
  bottomLeftActions?: ReactNode;
  /** Custom React node rendered at the far right of the bottom group's header. */
  bottomRightActions?: ReactNode;
  /** Browser annotator panel — single panel docked between center and right. */
  browser?: ReactNode;
  browserOpen?: boolean;
  browserTitle?: string;
  /** Fires when the user clicks the browser panel's native X. */
  onBrowserClose?: () => void;
  initialLeftWidth?: number;
  /** Where the left width is remembered: each thing the sidebar shows keeps
   *  its own (`dockview.left_width` when absent). */
  leftWidthMode?: LeftWidthMode;
  initialRightWidth?: number;
  initialBottomHeight?: number;
  initialBrowserWidth?: number;
};

/** Panels with one renderer each (host id = component id). */
const STATIC_PANEL_IDS = [PANEL_LEFT, PANEL_CENTER, PANEL_RIGHT, PANEL_BROWSER, PANEL_TOP];
/** Renderers shared by many panels (host id from the panel's `hostId` param). */
const DYNAMIC_PANEL_IDS = ['right-tab', 'bottom-tab'];

/**
 * Workspace layout backed by dockview-react.
 *
 * Layout:
 *   ┌───────┬──────────┬───────┐
 *   │ left  │  center  │ right │   <- headers hidden for left/center,
 *   │       ├──────────┤  (tabs│      visible for right (tab group)
 *   │       │  bottom  │  if   │
 *   │       │  (tabs)  │ given)│
 *   └───────┴──────────┴───────┘
 *
 * Each panel's React subtree is rendered into its dockview-managed DOM host
 * via createPortal, which preserves the parent React tree's context and state
 * across activations and tab reorders.
 */
export function DockviewLayout({
  left,
  center,
  top,
  topHeight = 48,
  right,
  rightTabs,
  activeRightTab,
  onActiveRightTabChange,
  rightPaneOpen = true,
  bottomTabs,
  activeBottomTab,
  onActiveBottomTabChange,
  onBottomTabClose,
  onBottomTabsReorder,
  bottomPaneOpen = true,
  leftPaneOpen = true,
  bottomPrefixActions,
  bottomLeftActions,
  bottomRightActions,
  browser,
  browserOpen = false,
  browserTitle = 'Browser',
  onBrowserClose,
  initialLeftWidth = 240,
  leftWidthMode,
  initialRightWidth = 400,
  initialBottomHeight = 280,
  initialBrowserWidth = 480,
}: DockviewLayoutProps) {
  const { resolvedTheme } = useTheme();
  const { hosts, components, tabComponents } = usePanelHosts(STATIC_PANEL_IDS, DYNAMIC_PANEL_IDS);
  const apiRef = useRef<DockviewApi | null>(null);

  const isTabbedRight = !!(rightTabs && rightTabs.length > 0);
  const refs = useLayoutPropRefs({
    rightTabs,
    activeRightTab,
    onActiveRightTabChange,
    bottomTabs,
    activeBottomTab,
    onActiveBottomTabChange,
    onBottomTabClose,
    onBottomTabsReorder,
    leftPaneOpen,
    bottomPrefixActions,
    bottomLeftActions,
    bottomRightActions,
    browserTitle,
    onBrowserClose,
    initialLeftWidth,
    initialRightWidth,
    initialBottomHeight,
    initialBrowserWidth,
  });

  const leftWidthKeyRef = useLeftWidthMode(
    apiRef,
    leftWidthMode ?? { storageKey: STORAGE_KEY_LEFT_WIDTH, defaultWidth: initialLeftWidth },
  );

  const ops = useLayoutPanelOps(refs, right);
  const { addBrowserPanel, removeBrowserPanel } = ops;

  const onReady = useLayoutReady({
    apiRef,
    refs,
    ops,
    top,
    topHeight,
    rightPaneOpen,
    browser,
    browserOpen,
    bottomPaneOpen,
    leftWidthKeyRef,
  });

  useLeftPaneSync(apiRef, leftPaneOpen);

  // Open/close the browser panel reactively when the prop changes. The
  // `reconcileAfterRestore` already pruned the panel on mount if the store
  // said closed, so this effect just needs to react to subsequent toggles.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const existing = api.getPanel(PANEL_BROWSER);
    if (browserOpen && browser !== undefined && !existing) {
      addBrowserPanel(api);
    } else if ((!browserOpen || browser === undefined) && existing) {
      removeBrowserPanel(api);
    }
  }, [browserOpen, browser, addBrowserPanel, removeBrowserPanel]);

  useLayoutRightPaneSync({
    apiRef,
    refs,
    ops,
    right,
    rightTabs,
    activeRightTab,
    isTabbedRight,
    rightPaneOpen,
  });

  useLayoutBottomPaneSync({ apiRef, refs, ops, bottomTabs, activeBottomTab, bottomPaneOpen });

  const theme = dockviewThemeFor(resolvedTheme);

  return (
    <>
      <BottomHeaderActionsProvider value={refs.bottomHeaderActions}>
        <DockviewReact
          components={components}
          tabComponents={tabComponents}
          prefixHeaderActionsComponent={PrefixHeaderActions}
          leftHeaderActionsComponent={LeftHeaderActions}
          rightHeaderActionsComponent={RightHeaderActions}
          onReady={onReady}
          theme={theme}
          singleTabMode="default"
          className="h-full w-full"
        />
      </BottomHeaderActionsProvider>
      {hosts[PANEL_LEFT] && createPortal(left, hosts[PANEL_LEFT])}
      {hosts[PANEL_CENTER] && createPortal(center, hosts[PANEL_CENTER])}
      {top !== undefined && hosts[PANEL_TOP] && createPortal(top, hosts[PANEL_TOP])}
      {!isTabbedRight &&
        right !== undefined &&
        hosts[PANEL_RIGHT] &&
        createPortal(right, hosts[PANEL_RIGHT])}
      {isTabbedRight &&
        rightTabs?.map((tab) => {
          const host = hosts[rightPanelId(tab.id)];
          // Every tab stays mounted (`renderer: 'always'`); only the active one
          // is shown, so a hidden tab cannot paint over or take focus.
          const active = (activeRightTab ?? rightTabs[0]?.id) === tab.id;
          return host
            ? createPortal(
                <div
                  className="h-full w-full"
                  hidden={!active}
                  aria-hidden={!active}
                  data-review-tab-content={tab.id}
                  data-testid={`review-tab-content-${tab.id}`}
                >
                  {tab.content}
                </div>,
                host,
                tab.id,
              )
            : null;
        })}
      {bottomTabs?.map((tab) => {
        const host = hosts[bottomPanelId(tab.id)];
        return host ? createPortal(tab.content, host, `bottom:${tab.id}`) : null;
      })}
      {browser !== undefined && hosts[PANEL_BROWSER] && createPortal(browser, hosts[PANEL_BROWSER])}
    </>
  );
}
