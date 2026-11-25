import type { DockviewApi } from 'dockview-react';

import { isRightPanelId } from '@/lib/dockview-right-panels';

import { writeStoredSize } from './layout-storage';

function findRightPanel(api: DockviewApi) {
  return api.panels.find((p) => isRightPanelId(p.id));
}

/** Whether the right pane has any panel. */
export function rightPaneExists(api: DockviewApi): boolean {
  return api.panels.some((p) => isRightPanelId(p.id));
}

/** The right group's current width, or null when absent or not laid out. */
export function getCurrentRightWidth(api: DockviewApi): number | null {
  const r = findRightPanel(api);
  if (!r) return null;
  const w = r.group.width;
  return Number.isFinite(w) && w > 0 ? w : null;
}

export function setRightPaneSize(api: DockviewApi, size: number) {
  const r = findRightPanel(api);
  if (r) r.api.setSize({ width: size });
}

/**
 * Dockview groups default to `minimumWidth = 100` (see
 * `MINIMUM_DOCKVIEW_GROUP_PANEL_WIDTH` in dockview-core). The splitview
 * clamps setSize to that floor, so without this drop a close animation
 * would visually park at 100px until `removePanels` snaps it gone.
 * We relax to 0 during the animation; on close the panel is gone before
 * the `animating=false` branch runs, on open we restore the floor.
 */
export function relaxRightMinWidth(api: DockviewApi, animating: boolean) {
  const r = findRightPanel(api);
  if (!r) return;
  r.group.api.setConstraints({
    minimumWidth: animating ? 0 : 100,
    maximumWidth: Number.MAX_SAFE_INTEGER,
  });
}

/** Persist the right group's width (if there is one) under `storageKey`. */
export function persistRightWidth(api: DockviewApi, storageKey: string) {
  const rp = findRightPanel(api);
  if (rp) writeStoredSize(storageKey, rp.group.width);
}
