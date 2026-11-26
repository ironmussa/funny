import { type DockviewApi, DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { useTheme } from 'next-themes';
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { PANEL_RIGHT, isRightPanelId } from '@/lib/dockview-right-panels';
import 'dockview-react/dist/styles/dockview.css';

import { notifyActiveTab, rightPanelId } from './dockview/layout-ids';
import { readStoredSize, restoreStoredLayout } from './dockview/layout-storage';
import { persistRightWidth } from './dockview/right-pane';
import { dockviewThemeFor } from './dockview/theme';
import type { RightTabSpec } from './dockview/types';
import { useCenterRightPaneSync } from './dockview/use-center-right-pane-sync';
import {
  CENTER_STORAGE_KEY_RIGHT_WIDTH,
  hidePanelHeader,
  useCenterRightPanelOps,
} from './dockview/use-center-right-panel-ops';
import { useDebouncedLayoutPersist } from './dockview/use-debounced-layout-persist';
import { usePanelHosts } from './dockview/use-panel-hosts';

/**
 * Inner dockview that lives INSIDE the center column. Hosts only the
 * [thread | right-tabs] horizontal split. Used so the ProjectHeader can sit
 * above the split (covering the full visible width of the center column,
 * including the right pane) without relying on a dockview top edge group —
 * which had a recurring bug where saved layouts could drag-resize the header
 * band because edge-group min/max constraints aren't preserved by fromJSON.
 *
 * Persistence: right pane width + active right tab. The outer DockviewLayout
 * still persists left width, bottom height, browser width, and its own grid.
 */

const PANEL_THREAD = 'thread';

const STORAGE_KEY_LAYOUT = 'center-dockview.layout.v1';

/** Panels with one renderer each (host id = component id). */
const STATIC_PANEL_IDS = [PANEL_THREAD, PANEL_RIGHT];
/** Renderers shared by many panels (host id from the panel's `hostId` param). */
const DYNAMIC_PANEL_IDS = ['right-tab'];

type Props = {
  /** Thread/main content — fills the left of the inner split. */
  thread: ReactNode;
  /** Single right panel (used when `rightTabs` not provided). */
  right?: ReactNode;
  /** Multi-tab right group. Tab headers visible, no close on tabs. */
  rightTabs?: RightTabSpec[];
  activeRightTab?: string;
  onActiveRightTabChange?: (id: string) => void;
  rightPaneOpen?: boolean;
  initialRightWidth?: number;
};

export function CenterDockview({
  thread,
  right,
  rightTabs,
  activeRightTab,
  onActiveRightTabChange,
  rightPaneOpen = true,
  initialRightWidth = 400,
}: Props) {
  const { resolvedTheme } = useTheme();
  const { hosts, components, tabComponents } = usePanelHosts(STATIC_PANEL_IDS, DYNAMIC_PANEL_IDS);
  const apiRef = useRef<DockviewApi | null>(null);

  const [storedRightWidth] = useState(() => readStoredSize(CENTER_STORAGE_KEY_RIGHT_WIDTH));
  const initialRightWidthRef = useRef(storedRightWidth ?? initialRightWidth);

  const isTabbedRight = !!(rightTabs && rightTabs.length > 0);
  const hasStandaloneRight = right !== undefined;
  const rightPaneOpenRef = useRef(rightPaneOpen);
  const rightTabsRef = useRef(rightTabs);
  const onActiveRightTabChangeRef = useRef(onActiveRightTabChange);
  const activeRightTabRef = useRef(activeRightTab);
  useLayoutEffect(() => {
    initialRightWidthRef.current = storedRightWidth ?? initialRightWidth;
    rightPaneOpenRef.current = rightPaneOpen;
    rightTabsRef.current = rightTabs;
    onActiveRightTabChangeRef.current = onActiveRightTabChange;
    activeRightTabRef.current = activeRightTab;
  }, [
    activeRightTab,
    initialRightWidth,
    onActiveRightTabChange,
    rightPaneOpen,
    rightTabs,
    storedRightWidth,
  ]);

  const ops = useCenterRightPanelOps({
    initialRightWidthRef,
    rightTabsRef,
    activeRightTabRef,
    hasStandaloneRight,
  });
  const { isAnimatingRef, isMutatingRightRef, addRightPanels, removeRightPanels } = ops;

  const buildDefaultLayout = useCallback(
    (api: DockviewApi) => {
      const threadPanel = api.addPanel({
        id: PANEL_THREAD,
        component: PANEL_THREAD,
        title: 'Thread',
      });
      hidePanelHeader(threadPanel);
      if (rightPaneOpen) addRightPanels(api);
    },
    [addRightPanels, rightPaneOpen],
  );

  const reconcileAfterRestore = useCallback((api: DockviewApi): boolean => {
    if (!api.getPanel(PANEL_THREAD)) return false;
    hidePanelHeader(api.getPanel(PANEL_THREAD)!);
    return true;
  }, []);

  const schedulePersistLayout = useDebouncedLayoutPersist(STORAGE_KEY_LAYOUT);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      const restored = restoreStoredLayout(event.api, STORAGE_KEY_LAYOUT, reconcileAfterRestore);
      if (!restored) {
        buildDefaultLayout(event.api);
      } else {
        // Reconcile the restored right panels with the open flag. The flag
        // (`tool_panels.open.right`) is written synchronously on toggle while the
        // layout snapshot is debounced — and the close path removes panels
        // while the persister is suppressed by `isAnimatingRef` — so after a
        // reload the stored layout can still contain right panels the flag
        // says are closed. Restoring them verbatim renders a zombie pane:
        // visible on screen, but every `reviewPaneOpen`-gated refresh (context
        // reset, ensure-loaded backstop, auto-refresh) stays off, leaving the
        // Changes tab stuck on a stale "No changes" for dirty worktrees.
        const hasRight = event.api.panels.some((p) => isRightPanelId(p.id));
        if (!rightPaneOpenRef.current && hasRight) {
          removeRightPanels(event.api);
          schedulePersistLayout(event.api);
        } else if (rightPaneOpenRef.current && !hasRight) {
          addRightPanels(event.api);
          schedulePersistLayout(event.api);
        }
      }

      event.api.onDidActivePanelChange((activePanelEvent) => {
        if (isMutatingRightRef.current) return;
        const panel = activePanelEvent.panel;
        if (!panel) return;
        notifyActiveTab(panel.id, 'right:', activeRightTabRef, onActiveRightTabChangeRef);
      });

      event.api.onDidLayoutChange(() => {
        if (isAnimatingRef.current) return;
        persistRightWidth(event.api, CENTER_STORAGE_KEY_RIGHT_WIDTH);
        schedulePersistLayout(event.api);
      });
    },
    [
      addRightPanels,
      buildDefaultLayout,
      isAnimatingRef,
      isMutatingRightRef,
      reconcileAfterRestore,
      removeRightPanels,
      schedulePersistLayout,
    ],
  );

  useCenterRightPaneSync({
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
  });

  const theme = dockviewThemeFor(resolvedTheme);

  return (
    <>
      <DockviewReact
        components={components}
        tabComponents={tabComponents}
        onReady={onReady}
        theme={theme}
        singleTabMode="default"
        className="h-full w-full"
      />
      {hosts[PANEL_THREAD] && createPortal(thread, hosts[PANEL_THREAD])}
      {!isTabbedRight &&
        right !== undefined &&
        hosts[PANEL_RIGHT] &&
        createPortal(right, hosts[PANEL_RIGHT])}
      {isTabbedRight &&
        rightTabs?.map((tab) => {
          const host = hosts[rightPanelId(tab.id)];
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
    </>
  );
}
