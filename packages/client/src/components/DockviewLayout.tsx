import {
  type DockviewApi,
  type DockviewGroupPanel,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanel,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type SerializedDockview,
} from 'dockview-react';
import { useTheme } from 'next-themes';
import {
  type FunctionComponent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import 'dockview-react/dist/styles/dockview.css';
import { useAnimatedPanelToggle } from './dockview/use-animated-panel-toggle';

/**
 * Custom dockview theme bound to the app's shadcn tokens. The actual CSS vars
 * live in globals.css (`.dockview-theme-funny`) and auto-switch with the app's
 * light/dark theme via shadcn's HSL variable set, so we don't need to swap
 * theme objects when the user changes color scheme.
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

/** A single tab inside the right-pane group (fixed set — not closeable). */
export type RightTabSpec = {
  id: string;
  title: string;
  content: ReactNode;
};

/** A single tab inside the bottom group (e.g. one terminal). User-closeable
 *  via dockview's native tab X. */
export type BottomTabSpec = {
  id: string;
  title: string;
  content: ReactNode;
};

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
  initialRightWidth?: number;
  initialBottomHeight?: number;
  initialBrowserWidth?: number;
};

const PANEL_LEFT = 'left';
const PANEL_CENTER = 'center';
const PANEL_RIGHT = 'right';
const PANEL_BROWSER = 'browser';
const PANEL_TOP = 'top';
/** Id of the LEFT-edge group container. The left sidebar panel lives INSIDE
 *  this group; the group itself is created once via `addEdgeGroup('left', ...)`
 *  in `buildDefaultLayout`. Edge groups have `priority = LayoutPriority.Low`
 *  built in, which means the splitview's proportional redistribution
 *  *never* takes from the sidebar — exactly what we want for a fixed-width
 *  sidebar. Replaces the previous `direction: 'left'` placement, which made
 *  the left a regular flexible view that absorbed delta from sibling resizes
 *  (and from `Sizing.Distribute` when the right pane was removed). */
const LEFT_EDGE_ID = 'left-edge';
/** Id of the TOP-edge group. The top edge group lives inside the shell's
 *  MIDDLE column (between left and right edges), so it spans the gridview's
 *  full width — i.e. across center + right pane. Use it for a header that
 *  needs to extend past the center column to the right border. */
const TOP_EDGE_ID = 'top-edge';
const rightPanelId = (tabId: string) => `right:${tabId}`;
const bottomPanelId = (tabId: string) => `bottom:${tabId}`;
const isRightPanelId = (id: string) => id.startsWith('right:') || id === PANEL_RIGHT;
const isBottomPanelId = (id: string) => id.startsWith('bottom:');

const STORAGE_KEY_LEFT_WIDTH = 'dockview.left_width';
const STORAGE_KEY_RIGHT_WIDTH = 'dockview.right_width';
const STORAGE_KEY_BOTTOM_HEIGHT = 'dockview.bottom_height';
const STORAGE_KEY_BROWSER_WIDTH = 'dockview.browser_width';
/** Full serialized layout. The version suffix lets us invalidate stored
 *  layouts after structural code changes (rename, new panel ids, etc.).
 *  v8 forces a rebuild because the top edge group was removed — the header
 *  is now rendered inside the center panel directly. Saved v7 layouts still
 *  have a `top-edge` group that would restore as a stale empty band. */
const STORAGE_KEY_LAYOUT = 'dockview.layout.v8';
/** Persist the layout at most every 500ms — splitter drags fire dozens of
 *  layout-change events and we don't want to thrash localStorage. */
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
  // Dockview fires `onDidLayoutChange` during initial setup with intermediate
  // values; persisting 0/NaN would clobber the real saved value.
  if (!Number.isFinite(size) || size < 1) return;
  try {
    localStorage.setItem(key, String(Math.round(size)));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

function readStoredLayout(): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LAYOUT);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Minimum-shape check — anything richer is for fromJSON to reject.
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
    /* ignore quota / privacy-mode errors */
  }
}

function clearStoredLayout() {
  try {
    localStorage.removeItem(STORAGE_KEY_LAYOUT);
  } catch {
    /* ignore */
  }
}

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
  bottomPrefixActions,
  bottomLeftActions,
  bottomRightActions,
  browser,
  browserOpen = false,
  browserTitle = 'Browser',
  onBrowserClose,
  initialLeftWidth = 240,
  initialRightWidth = 400,
  initialBottomHeight = 280,
  initialBrowserWidth = 480,
}: DockviewLayoutProps) {
  const { resolvedTheme } = useTheme();
  const [hosts, setHosts] = useState<Record<string, HTMLElement | null>>({});
  const apiRef = useRef<DockviewApi | null>(null);

  // ── Persistence: load stored sizes once on mount ──
  const storedLeftWidth = useRef<number | null>(readStoredSize(STORAGE_KEY_LEFT_WIDTH));
  const storedRightWidth = useRef<number | null>(readStoredSize(STORAGE_KEY_RIGHT_WIDTH));
  const storedBottomHeight = useRef<number | null>(readStoredSize(STORAGE_KEY_BOTTOM_HEIGHT));
  const storedBrowserWidth = useRef<number | null>(readStoredSize(STORAGE_KEY_BROWSER_WIDTH));
  const initialRightWidthRef = useRef(storedRightWidth.current ?? initialRightWidth);
  initialRightWidthRef.current = storedRightWidth.current ?? initialRightWidth;
  const initialBottomHeightRef = useRef(storedBottomHeight.current ?? initialBottomHeight);
  initialBottomHeightRef.current = storedBottomHeight.current ?? initialBottomHeight;
  const initialBrowserWidthRef = useRef(storedBrowserWidth.current ?? initialBrowserWidth);
  initialBrowserWidthRef.current = storedBrowserWidth.current ?? initialBrowserWidth;
  const initialLeftWidthResolved = storedLeftWidth.current ?? initialLeftWidth;

  // ── Latest-prop refs so callbacks/effects don't need to re-create ──
  const isTabbedRight = !!(rightTabs && rightTabs.length > 0);
  const rightTabsRef = useRef(rightTabs);
  rightTabsRef.current = rightTabs;
  const onActiveRightTabChangeRef = useRef(onActiveRightTabChange);
  onActiveRightTabChangeRef.current = onActiveRightTabChange;
  const activeRightTabRef = useRef(activeRightTab);
  activeRightTabRef.current = activeRightTab;

  const bottomTabsRef = useRef(bottomTabs);
  bottomTabsRef.current = bottomTabs;
  const onActiveBottomTabChangeRef = useRef(onActiveBottomTabChange);
  onActiveBottomTabChangeRef.current = onActiveBottomTabChange;
  const onBottomTabCloseRef = useRef(onBottomTabClose);
  onBottomTabCloseRef.current = onBottomTabClose;
  const onBottomTabsReorderRef = useRef(onBottomTabsReorder);
  onBottomTabsReorderRef.current = onBottomTabsReorder;
  const activeBottomTabRef = useRef(activeBottomTab);
  activeBottomTabRef.current = activeBottomTab;

  const onBrowserCloseRef = useRef(onBrowserClose);
  onBrowserCloseRef.current = onBrowserClose;
  const browserTitleRef = useRef(browserTitle);
  browserTitleRef.current = browserTitle;

  // Bottom header action components are rendered globally by dockview; we read
  // their JSX at render time via refs so the renderer functions stay stable.
  const bottomPrefixActionsRef = useRef(bottomPrefixActions);
  bottomPrefixActionsRef.current = bottomPrefixActions;
  const bottomLeftActionsRef = useRef(bottomLeftActions);
  bottomLeftActionsRef.current = bottomLeftActions;
  const bottomRightActionsRef = useRef(bottomRightActions);
  bottomRightActionsRef.current = bottomRightActions;

  const setHostRef = useCallback((id: string, el: HTMLElement | null) => {
    setHosts((prev) => (prev[id] === el ? prev : { ...prev, [id]: el }));
  }, []);

  // ── Component & tab renderers ──
  const components = useMemo(() => {
    const make = (id: string) => () => <PanelHost id={id} onMount={setHostRef} />;
    const dynamicRenderer = (props: IDockviewPanelProps<{ hostId?: string }>) => {
      const hostId = props.params?.hostId ?? props.api.id;
      return <PanelHost id={hostId} onMount={setHostRef} />;
    };
    return {
      [PANEL_LEFT]: make(PANEL_LEFT),
      [PANEL_CENTER]: make(PANEL_CENTER),
      [PANEL_RIGHT]: make(PANEL_RIGHT),
      [PANEL_BROWSER]: make(PANEL_BROWSER),
      [PANEL_TOP]: make(PANEL_TOP),
      'right-tab': dynamicRenderer,
      'bottom-tab': dynamicRenderer,
    };
  }, [setHostRef]);

  // Custom tab component for right-pane tabs: title only, no close button.
  // Terminal tabs use dockview's default tab (with X) by NOT setting tabComponent.
  const tabComponents = useMemo(
    () => ({
      'right-tab': RightTabHeader,
    }),
    [],
  );

  // Bottom-group header action renderers. These are global (dockview invokes
  // them for every group), so we conditionally render based on group id.
  const PrefixHeaderActions = useMemo<FunctionComponent<IDockviewHeaderActionsProps>>(
    () =>
      function PrefixHeaderActions({ group }) {
        if (!isBottomGroup(group)) return null;
        return <>{bottomPrefixActionsRef.current ?? null}</>;
      },
    [],
  );
  const LeftHeaderActions = useMemo<FunctionComponent<IDockviewHeaderActionsProps>>(
    () =>
      function LeftHeaderActions({ group }) {
        if (!isBottomGroup(group)) return null;
        return <>{bottomLeftActionsRef.current ?? null}</>;
      },
    [],
  );
  const RightHeaderActions = useMemo<FunctionComponent<IDockviewHeaderActionsProps>>(
    () =>
      function RightHeaderActions({ group }) {
        if (!isBottomGroup(group)) return null;
        return <>{bottomRightActionsRef.current ?? null}</>;
      },
    [],
  );

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
      const desiredWidth = widthOverride ?? initialRightWidthRef.current;
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

  // ── Browser-panel management ──
  /** Add the browser panel to the right of center (between center and right). */
  const addBrowserPanel = useCallback((api: DockviewApi) => {
    return api.addPanel({
      id: PANEL_BROWSER,
      component: PANEL_BROWSER,
      title: browserTitleRef.current,
      // `direction: 'right', referencePanel: 'center'` splits center's column
      // horizontally; since the right group was added with an ABSOLUTE 'right'
      // direction (root level), the new browser panel slots between the center
      // column and the right group → [left | center | browser | right].
      position: { direction: 'right', referencePanel: PANEL_CENTER },
      initialWidth: initialBrowserWidthRef.current,
    });
  }, []);

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
        initialHeight: heightOverride ?? initialBottomHeightRef.current,
        renderer: 'always',
      });
    },
    [],
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
    [addBottomTabToGroup, addInitialBottomPanel],
  );

  /** Panel ids that we're closing programmatically — used to suppress the
   *  `onBottomTabClose` callback so the store doesn't bounce. */
  const suppressCloseRef = useRef<Set<string>>(new Set());

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
        // 0 keeps the historical "no stub" behaviour. Bump this later if we
        // want a VSCode-style activity-bar strip when the sidebar is closed.
        collapsedSize: 0,
        collapsed: false,
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
    [browser, browserOpen, hideHeader, top, topHeight],
  );

  /** Debounced layout persister — `onDidLayoutChange` fires on every pixel of
   *  a splitter drag. */
  const persistLayoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePersistLayout = useCallback((api: DockviewApi) => {
    if (persistLayoutTimeoutRef.current) clearTimeout(persistLayoutTimeoutRef.current);
    persistLayoutTimeoutRef.current = setTimeout(() => {
      try {
        writeStoredLayout(api.toJSON());
      } catch {
        /* defensive — toJSON should never throw, but don't crash the app */
      }
    }, LAYOUT_PERSIST_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (persistLayoutTimeoutRef.current) clearTimeout(persistLayoutTimeoutRef.current);
    },
    [],
  );

  // ── onReady: build initial layout + subscribe to events ──
  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      // Try to restore the user's full saved layout first. If that fails (or
      // it leaves us in a corrupt state with missing left/center), clear the
      // bad blob and fall back to the default layout.
      const storedLayout = readStoredLayout();
      let restored = false;
      if (storedLayout) {
        try {
          event.api.fromJSON(storedLayout);
          restored = reconcileAfterRestore(event.api);
          if (!restored) {
            clearStoredLayout();
            // fromJSON left the dockview in a partial state — wipe it.
            for (const p of [...event.api.panels]) {
              suppressCloseRef.current.add(p.id);
              p.api.close();
            }
          }
        } catch {
          clearStoredLayout();
          // fromJSON may have left the dockview in a partial state — wipe it.
          for (const p of [...event.api.panels]) {
            suppressCloseRef.current.add(p.id);
            p.api.close();
          }
          restored = false;
        }
      }
      if (!restored) {
        buildDefaultLayout(event.api);
      }

      // Active panel changes → notify the store(s).
      event.api.onDidActivePanelChange((panel) => {
        if (!panel) return;
        if (panel.id.startsWith('right:')) {
          const tabId = panel.id.slice('right:'.length);
          if (tabId !== activeRightTabRef.current) {
            onActiveRightTabChangeRef.current?.(tabId);
          }
        } else if (panel.id.startsWith('bottom:')) {
          const tabId = panel.id.slice('bottom:'.length);
          if (tabId !== activeBottomTabRef.current) {
            onActiveBottomTabChangeRef.current?.(tabId);
          }
        }
      });

      // Panel removal — bounce to the corresponding store handler unless WE
      // initiated the close (programmatic sync / open toggle).
      event.api.onDidRemovePanel((panel) => {
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
      let lastBottomOrder = readBottomOrder(event.api);
      event.api.onDidLayoutChange(() => {
        // While a toggle animation is in flight, skip persistence — the
        // intermediate frame widths/heights would otherwise overwrite the
        // user's real values in localStorage (e.g. animating to 0 would
        // persist a width of 0 for the right pane).
        if (isAnimatingRef.current) return;

        // Persist left/right/browser widths and bottom height (cheap, always)
        const lp = event.api.getPanel(PANEL_LEFT);
        if (lp) writeStoredSize(STORAGE_KEY_LEFT_WIDTH, lp.group.width);
        const rp = event.api.panels.find((p) => isRightPanelId(p.id));
        if (rp) writeStoredSize(STORAGE_KEY_RIGHT_WIDTH, rp.group.width);
        const bp = event.api.panels.find((p) => isBottomPanelId(p.id));
        if (bp) writeStoredSize(STORAGE_KEY_BOTTOM_HEIGHT, bp.group.height);
        const browserPanel = event.api.getPanel(PANEL_BROWSER);
        if (browserPanel) {
          writeStoredSize(STORAGE_KEY_BROWSER_WIDTH, browserPanel.group.width);
        }

        // Persist the FULL layout (positions + sizes + active panels) — this
        // is what lets the user's custom arrangement survive a reload.
        schedulePersistLayout(event.api);

        // Detect bottom-tab reorder.
        const order = readBottomOrder(event.api);
        if (order.length === lastBottomOrder.length && !sameOrder(order, lastBottomOrder)) {
          onBottomTabsReorderRef.current?.(order);
        }
        lastBottomOrder = order;
      });
    },
    [buildDefaultLayout, reconcileAfterRestore, schedulePersistLayout],
  );

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

  // ── Right-pane effects ──
  /** Animated open/close of the right pane. Drives `setSize` frame-by-frame
   *  from current → 0 (close) or 1 → persisted-width (open), then removes
   *  panels on close. While animating, `onRightAnimating` suppresses
   *  layout persistence and pins the left sidebar so it doesn't "breathe"
   *  as proportional space is redistributed. */
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
    // Prefer the freshly-persisted value over the mount-time ref — honors a
    // mid-session drag if the user closes and reopens within the same session.
    const stored = readStoredSize(STORAGE_KEY_RIGHT_WIDTH);
    return stored ?? initialRightWidthRef.current;
  }, []);
  const onRightAnimating = useCallback((animating: boolean, api: DockviewApi) => {
    isAnimatingRef.current = animating;
    // Dockview groups default to `minimumWidth = 100` (see
    // `MINIMUM_DOCKVIEW_GROUP_PANEL_WIDTH` in dockview-core). The splitview
    // clamps setSize to that floor, so without this drop our close animation
    // would visually park at 100px until `removePanels` snaps it gone.
    // We relax to 0 during the animation; on close the panel is gone before
    // the `animating=false` branch runs, on open we restore the floor.
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
    const expectedIds =
      rightTabsRef.current && rightTabsRef.current.length > 0
        ? rightTabsRef.current.map((t) => rightPanelId(t.id))
        : right !== undefined
          ? [PANEL_RIGHT]
          : [];
    const existingIds = api.panels.filter((p) => isRightPanelId(p.id)).map((p) => p.id);
    if (sameSet(existingIds, expectedIds)) return;

    const currentWidth = getCurrentRightWidth(api);
    removeRightPanels(api);
    addRightPanels(api, currentWidth ?? undefined);
  }, [rightTabsSig, rightPaneOpen, right, addRightPanels, removeRightPanels, getCurrentRightWidth]);

  // ── Bottom-pane effects ──
  // Tracks the previous value of `bottomPaneOpen` so we only tear down restored
  // panels on an explicit user-driven `true → false` transition. On initial
  // mount the terminal store may transiently report `bottomPaneOpen=false`
  // (while rehydrating from localStorage) — without this guard we would close
  // panels that `fromJSON` just restored, destroying the user's saved split
  // group structure (all tabs end up collapsed into a single group on reload).
  const prevBottomPaneOpenRef = useRef<boolean | null>(null);
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const hasBottom = api.panels.some((p) => isBottomPanelId(p.id));
    const prev = prevBottomPaneOpenRef.current;
    prevBottomPaneOpenRef.current = bottomPaneOpen;
    if (bottomPaneOpen && !hasBottom) {
      syncBottomPanels(api);
    } else if (!bottomPaneOpen && hasBottom && prev === true) {
      // Close all bottom panels without bouncing close events to the store.
      for (const p of api.panels.filter((x) => isBottomPanelId(x.id))) {
        suppressCloseRef.current.add(p.id);
        p.api.close();
      }
    }
  }, [bottomPaneOpen, syncBottomPanels]);

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
      const detail = (e as CustomEvent<{ tabId: string }>).detail;
      const tabId = detail?.tabId;
      if (!tabId) return;
      const api = apiRef.current;
      if (!api) return;
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
              initialHeight: initialBottomHeightRef.current,
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
            height: Math.max(initialBottomHeightRef.current, 360),
            left: window.screenX + 80,
            top: window.screenY + 80,
          },
        });
      }
    };
    window.addEventListener('dockview:popout-bottom', handler);
    return () => window.removeEventListener('dockview:popout-bottom', handler);
  }, []);

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
  }, [bottomTabsSig, bottomPaneOpen, syncBottomPanels]);

  useEffect(() => {
    if (!activeBottomTab) return;
    const api = apiRef.current;
    if (!api) return;
    const panel = api.getPanel(bottomPanelId(activeBottomTab));
    if (panel && !panel.api.isActive) panel.api.setActive();
  }, [activeBottomTab]);

  const theme = resolvedTheme === 'light' ? themeFunnyLight : themeFunnyDark;

  return (
    <>
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
          return host ? createPortal(tab.content, host, tab.id) : null;
        })}
      {bottomTabs?.map((tab) => {
        const host = hosts[bottomPanelId(tab.id)];
        return host ? createPortal(tab.content, host, `bottom:${tab.id}`) : null;
      })}
      {browser !== undefined && hosts[PANEL_BROWSER] && createPortal(browser, hosts[PANEL_BROWSER])}
    </>
  );
}

// ── Helpers ──

function isBottomGroup(group: DockviewGroupPanel): boolean {
  return group.panels.some((p) => p.id.startsWith('bottom:'));
}

function readBottomOrder(api: DockviewApi): string[] {
  const group = api.panels.find((p) => p.id.startsWith('bottom:'))?.group;
  if (!group) return [];
  return group.panels
    .map((p) => p.id)
    .filter((id) => id.startsWith('bottom:'))
    .map((id) => id.slice('bottom:'.length));
}

function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
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

/** Tab renderer for right-pane tabs — title only, no close button. */
function RightTabHeader(props: IDockviewPanelHeaderProps) {
  return (
    <div className="dv-funny-right-tab flex h-full items-center px-2.5 text-[11px] font-medium">
      {props.api.title}
    </div>
  );
}
