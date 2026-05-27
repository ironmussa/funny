import { type DockviewApi } from 'dockview-react';
import { type MutableRefObject, useEffect } from 'react';

/**
 * Reconciles `leftPaneOpen` against the dockview LEFT edge group.
 *
 * Why a hook: the layout is built fresh on mount and always starts uncollapsed,
 * so a persisted-cookie "closed" state needs to be reapplied imperatively.
 * Subsequent flips of `leftPaneOpen` collapse/expand the existing group in
 * place. `collapsedSize: 0` is set at edge-group creation, so collapsed = fully
 * hidden; `expand()` restores the last expanded size.
 */
export function useLeftPaneSync(
  apiRef: MutableRefObject<DockviewApi | null>,
  leftPaneOpen: boolean,
): void {
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const group = api.getEdgeGroup('left');
    if (!group) return;
    if (leftPaneOpen && group.isCollapsed()) {
      group.expand();
    } else if (!leftPaneOpen && !group.isCollapsed()) {
      group.collapse();
    }
  }, [apiRef, leftPaneOpen]);
}
