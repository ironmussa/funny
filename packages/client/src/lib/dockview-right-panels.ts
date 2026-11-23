import type { DockviewApi } from 'dockview-react';

/** The id of the single right-hand panel, when the right pane is not tabbed. */
export const PANEL_RIGHT = 'right';

/** Whether a dockview panel belongs to the right-hand pane (its tabs, or the single panel). */
export const isRightPanelId = (id: string) => id.startsWith('right:') || id === PANEL_RIGHT;

/** Closes every panel of the right-hand pane. */
export function closeRightPanels(api: DockviewApi): void {
  const ids = api.panels.filter((p) => isRightPanelId(p.id)).map((p) => p.id);
  for (const id of ids) {
    api.getPanel(id)?.api.close();
  }
}
