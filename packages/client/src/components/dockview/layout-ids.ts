import type { DockviewApi } from 'dockview-react';

export const PANEL_LEFT = 'left';
export const PANEL_CENTER = 'center';
export const PANEL_BROWSER = 'browser';
export const PANEL_TOP = 'top';
/** Id of the LEFT-edge group container. The left sidebar panel lives INSIDE
 *  this group; the group itself is created once via `addEdgeGroup('left', ...)`
 *  in `buildDefaultLayout`. Edge groups have `priority = LayoutPriority.Low`
 *  built in, which means the splitview's proportional redistribution
 *  *never* takes from the sidebar — exactly what we want for a fixed-width
 *  sidebar. Replaces the previous `direction: 'left'` placement, which made
 *  the left a regular flexible view that absorbed delta from sibling resizes
 *  (and from `Sizing.Distribute` when the right pane was removed). */
export const LEFT_EDGE_ID = 'left-edge';
/** Id of the TOP-edge group. The top edge group lives inside the shell's
 *  MIDDLE column (between left and right edges), so it spans the gridview's
 *  full width — i.e. across center + right pane. Use it for a header that
 *  needs to extend past the center column to the right border. */
export const TOP_EDGE_ID = 'top-edge';
export const rightPanelId = (tabId: string) => `right:${tabId}`;
export const bottomPanelId = (tabId: string) => `bottom:${tabId}`;
export const isBottomPanelId = (id: string) => id.startsWith('bottom:');

export const STORAGE_KEY_LEFT_WIDTH = 'dockview.left_width';
/** The left sidebar's width while it shows the factory queue, which needs more room. */
export const STORAGE_KEY_FACTORY_LEFT_WIDTH = 'dockview.left_width.factory';
/** The left sidebar's width while it shows the kanban board. */
export const STORAGE_KEY_KANBAN_LEFT_WIDTH = 'dockview.left_width.kanban';
/** The left sidebar's width while it shows the automation inbox beside an open thread. */
export const STORAGE_KEY_INBOX_LEFT_WIDTH = 'dockview.left_width.inbox';
export const STORAGE_KEY_RIGHT_WIDTH = 'dockview.right_width';
export const STORAGE_KEY_BOTTOM_HEIGHT = 'dockview.bottom_height';
export const STORAGE_KEY_BROWSER_WIDTH = 'dockview.browser_width';
/** Full serialized layout. The version suffix lets us invalidate stored
 *  layouts after structural code changes (rename, new panel ids, etc.).
 *  v9: the right panels moved here from the inner `CenterDockview`, which is
 *  gone (openspec `tool-panels`); a v8 layout has no right group and the
 *  thread header outside the grid. */
export const STORAGE_KEY_LAYOUT = 'dockview.layout.v9';

/** Keys written by layouts before {@link STORAGE_KEY_LAYOUT}, removed on load. */
export const RETIRED_LAYOUT_KEYS = ['dockview.layout.v8', 'center-dockview.layout.v1'];
/** The inner dockview's right-pane width, carried over to {@link STORAGE_KEY_RIGHT_WIDTH}. */
export const RETIRED_RIGHT_WIDTH_KEY = 'center-dockview.right_width';

export function readBottomOrder(api: DockviewApi): string[] {
  const group = api.panels.find((p) => p.id.startsWith('bottom:'))?.group;
  if (!group) return [];
  return group.panels
    .map((p) => p.id)
    .filter((id) => id.startsWith('bottom:'))
    .map((id) => id.slice('bottom:'.length));
}

export function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

/**
 * If `panelId` is a `<prefix><tabId>` tab panel, report its tab id to
 * `onChangeRef` (unless it is already the active tab) and return true.
 */
export function notifyActiveTab(
  panelId: string,
  prefix: string,
  activeTabRef: { current: string | undefined },
  onChangeRef: { current: ((id: string) => void) | undefined },
): boolean {
  if (!panelId.startsWith(prefix)) return false;
  const tabId = panelId.slice(prefix.length);
  if (tabId !== activeTabRef.current) {
    onChangeRef.current?.(tabId);
  }
  return true;
}
