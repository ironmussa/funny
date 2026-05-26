import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanel,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type SerializedDockview,
} from 'dockview-react';
import { useTheme } from 'next-themes';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import 'dockview-react/dist/styles/dockview.css';
import { useAnimatedPanelToggle } from './dockview/use-animated-panel-toggle';
import type { RightTabSpec } from './DockviewLayout';

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

const themeFunnyLight: DockviewTheme = {
  name: 'funny-light',
  className: 'dockview-theme-funny',
  colorScheme: 'light',
  tabGroupIndicator: 'none',
};
const themeFunnyDark: DockviewTheme = {
  name: 'funny-dark',
  className: 'dockview-theme-funny',
  colorScheme: 'dark',
  tabGroupIndicator: 'none',
};

const PANEL_THREAD = 'thread';
const PANEL_RIGHT = 'right';
const rightPanelId = (tabId: string) => `right:${tabId}`;
const isRightPanelId = (id: string) => id.startsWith('right:') || id === PANEL_RIGHT;

const STORAGE_KEY_RIGHT_WIDTH = 'center-dockview.right_width';
const STORAGE_KEY_LAYOUT = 'center-dockview.layout.v1';
const LAYOUT_PERSIST_DEBOUNCE_MS = 500;

function readStoredSize(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeStoredSize(key: string, size: number) {
  if (!Number.isFinite(size) || size < 1) return;
  try {
    localStorage.setItem(key, String(Math.round(size)));
  } catch {
    /* ignore */
  }
}

function readStoredLayout(): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LAYOUT);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'grid' in parsed && 'panels' in parsed) {
      return parsed as SerializedDockview;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredLayout(layout: SerializedDockview) {
  try {
    localStorage.setItem(STORAGE_KEY_LAYOUT, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

function clearStoredLayout() {
  try {
    localStorage.removeItem(STORAGE_KEY_LAYOUT);
  } catch {
    /* ignore */
  }
}

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
  const [hosts, setHosts] = useState<Record<string, HTMLElement | null>>({});
  const apiRef = useRef<DockviewApi | null>(null);

  const storedRightWidth = useRef<number | null>(readStoredSize(STORAGE_KEY_RIGHT_WIDTH));
  const initialRightWidthRef = useRef(storedRightWidth.current ?? initialRightWidth);
  initialRightWidthRef.current = storedRightWidth.current ?? initialRightWidth;

  const isTabbedRight = !!(rightTabs && rightTabs.length > 0);
  const rightTabsRef = useRef(rightTabs);
  rightTabsRef.current = rightTabs;
  const onActiveRightTabChangeRef = useRef(onActiveRightTabChange);
  onActiveRightTabChangeRef.current = onActiveRightTabChange;
  const activeRightTabRef = useRef(activeRightTab);
  activeRightTabRef.current = activeRightTab;

  const setHostRef = useCallback((id: string, el: HTMLElement | null) => {
    setHosts((prev) => (prev[id] === el ? prev : { ...prev, [id]: el }));
  }, []);

  const components = useMemo(() => {
    const make = (id: string) => () => <PanelHost id={id} onMount={setHostRef} />;
    const dynamicRenderer = (props: IDockviewPanelProps<{ hostId?: string }>) => {
      const hostId = props.params?.hostId ?? props.api.id;
      return <PanelHost id={hostId} onMount={setHostRef} />;
    };
    return {
      [PANEL_THREAD]: make(PANEL_THREAD),
      [PANEL_RIGHT]: make(PANEL_RIGHT),
      'right-tab': dynamicRenderer,
    };
  }, [setHostRef]);

  const tabComponents = useMemo(
    () => ({
      'right-tab': RightTabHeader,
    }),
    [],
  );

  const hideHeader = useCallback((panel: IDockviewPanel) => {
    panel.group.header.hidden = true;
  }, []);

  const isAnimatingRef = useRef(false);

  const addRightPanels = useCallback(
    (api: DockviewApi, widthOverride?: number) => {
      const desiredWidth = widthOverride ?? initialRightWidthRef.current;
      const tabs = rightTabsRef.current;
      if (tabs && tabs.length > 0) {
        for (let i = 0; i < tabs.length; i++) {
          const tab = tabs[i];
          api.addPanel({
            id: rightPanelId(tab.id),
            component: 'right-tab',
            tabComponent: 'right-tab',
            title: tab.title,
            params: { hostId: rightPanelId(tab.id) },
            position:
              i === 0
                ? { direction: 'right' }
                : { direction: 'within', referencePanel: rightPanelId(tabs[0].id) },
            initialWidth: i === 0 ? desiredWidth : undefined,
            renderer: 'always',
          });
        }
        const desired = activeRightTabRef.current ?? tabs[0].id;
        const target = api.getPanel(rightPanelId(desired));
        target?.api.setActive();
      } else if (right !== undefined) {
        const panel = api.addPanel({
          id: PANEL_RIGHT,
          component: PANEL_RIGHT,
          title: 'Right',
          position: { direction: 'right' },
          initialWidth: desiredWidth,
        });
        hideHeader(panel);
      }
    },
    [hideHeader, right],
  );

  const getCurrentRightWidth = useCallback((api: DockviewApi): number | null => {
    const r = api.panels.find((p) => isRightPanelId(p.id));
    if (!r) return null;
    const w = r.group.width;
    return Number.isFinite(w) && w > 0 ? w : null;
  }, []);

  const removeRightPanels = useCallback((api: DockviewApi) => {
    const ids = api.panels.filter((p) => isRightPanelId(p.id)).map((p) => p.id);
    for (const id of ids) {
      api.getPanel(id)?.api.close();
    }
  }, []);

  const buildDefaultLayout = useCallback(
    (api: DockviewApi) => {
      const threadPanel = api.addPanel({
        id: PANEL_THREAD,
        component: PANEL_THREAD,
        title: 'Thread',
      });
      hideHeader(threadPanel);
      if (rightPaneOpen) addRightPanels(api);
    },
    [addRightPanels, hideHeader, rightPaneOpen],
  );

  const reconcileAfterRestore = useCallback(
    (api: DockviewApi): boolean => {
      if (!api.getPanel(PANEL_THREAD)) return false;
      hideHeader(api.getPanel(PANEL_THREAD)!);
      return true;
    },
    [hideHeader],
  );

  const persistLayoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePersistLayout = useCallback((api: DockviewApi) => {
    if (persistLayoutTimeoutRef.current) clearTimeout(persistLayoutTimeoutRef.current);
    persistLayoutTimeoutRef.current = setTimeout(() => {
      try {
        writeStoredLayout(api.toJSON());
      } catch {
        /* ignore */
      }
    }, LAYOUT_PERSIST_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (persistLayoutTimeoutRef.current) clearTimeout(persistLayoutTimeoutRef.current);
    },
    [],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      const storedLayout = readStoredLayout();
      let restored = false;
      if (storedLayout) {
        try {
          event.api.fromJSON(storedLayout);
          restored = reconcileAfterRestore(event.api);
          if (!restored) {
            clearStoredLayout();
            for (const p of [...event.api.panels]) {
              p.api.close();
            }
          }
        } catch {
          clearStoredLayout();
          for (const p of [...event.api.panels]) {
            p.api.close();
          }
          restored = false;
        }
      }
      if (!restored) {
        buildDefaultLayout(event.api);
      }

      event.api.onDidActivePanelChange((panel) => {
        if (!panel) return;
        if (panel.id.startsWith('right:')) {
          const tabId = panel.id.slice('right:'.length);
          if (tabId !== activeRightTabRef.current) {
            onActiveRightTabChangeRef.current?.(tabId);
          }
        }
      });

      event.api.onDidLayoutChange(() => {
        if (isAnimatingRef.current) return;
        const rp = event.api.panels.find((p) => isRightPanelId(p.id));
        if (rp) writeStoredSize(STORAGE_KEY_RIGHT_WIDTH, rp.group.width);
        schedulePersistLayout(event.api);
      });
    },
    [buildDefaultLayout, reconcileAfterRestore, schedulePersistLayout],
  );

  // Animated right-pane toggle (mirrors DockviewLayout's animation).
  const rightExists = useCallback(
    (api: DockviewApi) => api.panels.some((p) => isRightPanelId(p.id)),
    [],
  );
  const getRightSize = useCallback(
    (api: DockviewApi) => getCurrentRightWidth(api),
    [getCurrentRightWidth],
  );
  const setRightSize = useCallback((api: DockviewApi, size: number) => {
    const r = api.panels.find((p) => isRightPanelId(p.id));
    if (r) r.api.setSize({ width: size });
  }, []);
  const getRightOpenSize = useCallback(() => {
    const stored = readStoredSize(STORAGE_KEY_RIGHT_WIDTH);
    return stored ?? initialRightWidthRef.current;
  }, []);
  const onRightAnimating = useCallback((animating: boolean, api: DockviewApi) => {
    isAnimatingRef.current = animating;
    const r = api.panels.find((p) => isRightPanelId(p.id));
    if (!r) return;
    if (animating) {
      r.group.api.setConstraints({
        minimumWidth: 0,
        maximumWidth: Number.MAX_SAFE_INTEGER,
      });
    } else {
      r.group.api.setConstraints({
        minimumWidth: 100,
        maximumWidth: Number.MAX_SAFE_INTEGER,
      });
    }
  }, []);
  useAnimatedPanelToggle({
    apiRef,
    open: rightPaneOpen,
    exists: rightExists,
    getSize: getRightSize,
    setSize: setRightSize,
    addPanels: addRightPanels,
    removePanels: removeRightPanels,
    getOpenSize: getRightOpenSize,
    onAnimating: onRightAnimating,
  });

  useEffect(() => {
    if (!isTabbedRight || !activeRightTab) return;
    const api = apiRef.current;
    if (!api) return;
    const panel = api.getPanel(rightPanelId(activeRightTab));
    if (panel && !panel.api.isActive) panel.api.setActive();
  }, [activeRightTab, isTabbedRight]);

  // Re-sync right panel set when tabs prop changes.
  const rightTabsSig = (rightTabs ?? []).map((t) => `${t.id}|${t.title}`).join(',');
  const lastSyncedRightSigRef = useRef<string | null>(null);
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (!rightPaneOpen) return;
    if (lastSyncedRightSigRef.current === null) {
      lastSyncedRightSigRef.current = rightTabsSig;
      return;
    }
    if (lastSyncedRightSigRef.current === rightTabsSig) return;
    lastSyncedRightSigRef.current = rightTabsSig;

    const expectedIds =
      rightTabsRef.current && rightTabsRef.current.length > 0
        ? rightTabsRef.current.map((t) => rightPanelId(t.id))
        : right !== undefined
          ? [PANEL_RIGHT]
          : [];
    const existingIds = api.panels.filter((p) => isRightPanelId(p.id)).map((p) => p.id);
    const same =
      existingIds.length === expectedIds.length &&
      expectedIds.every((id) => existingIds.includes(id));
    if (same) return;

    const currentWidth = getCurrentRightWidth(api);
    removeRightPanels(api);
    addRightPanels(api, currentWidth ?? undefined);
  }, [rightTabsSig, rightPaneOpen, right, addRightPanels, removeRightPanels, getCurrentRightWidth]);

  const theme = resolvedTheme === 'light' ? themeFunnyLight : themeFunnyDark;

  return (
    <>
      <DockviewReact
        components={components}
        tabComponents={tabComponents}
        onReady={onReady}
        theme={theme}
        singleTabMode="fullwidth"
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
          return host ? createPortal(tab.content, host, tab.id) : null;
        })}
    </>
  );
}

function PanelHost({
  id,
  onMount,
}: {
  id: string;
  onMount: (id: string, el: HTMLElement | null) => void;
}) {
  const ref = useCallback((el: HTMLDivElement | null) => onMount(id, el), [id, onMount]);
  return <div ref={ref} className="h-full w-full overflow-hidden" />;
}

function RightTabHeader(props: IDockviewPanelHeaderProps) {
  return (
    <div className="dv-funny-right-tab flex h-full items-center px-2.5 text-[11px] font-medium">
      {props.api.title}
    </div>
  );
}
