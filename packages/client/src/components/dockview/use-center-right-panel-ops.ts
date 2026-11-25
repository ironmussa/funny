import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { type MutableRefObject, useCallback, useRef } from 'react';

import { PANEL_RIGHT, closeRightPanels } from '@/lib/dockview-right-panels';
import { withCleanupSync } from '@/lib/while-pending';

import { rightPanelId } from './layout-ids';
import { readStoredSize } from './layout-storage';
import type { RightTabSpec } from './types';

export const CENTER_STORAGE_KEY_RIGHT_WIDTH = 'center-dockview.right_width';

export function hidePanelHeader(panel: IDockviewPanel) {
  panel.group.header.hidden = true;
}

type CenterRightPanelOpsInput = {
  initialRightWidthRef: MutableRefObject<number>;
  rightTabsRef: MutableRefObject<RightTabSpec[] | undefined>;
  activeRightTabRef: MutableRefObject<string | undefined>;
  hasStandaloneRight: boolean;
};

/** Add/remove operations on CenterDockview's right panels, with the flags
 *  its event handlers check while those operations run. */
export function useCenterRightPanelOps({
  initialRightWidthRef,
  rightTabsRef,
  activeRightTabRef,
  hasStandaloneRight,
}: CenterRightPanelOpsInput) {
  const isAnimatingRef = useRef(false);
  // Suppress onDidActivePanelChange during programmatic open/close of right
  // panels. Closing panels one-by-one makes dockview activate the next-in-line
  // each step, which would otherwise overwrite the user's selected tab in the
  // store (and in localStorage) with whichever panel happened to be last alive.
  const isMutatingRightRef = useRef(false);

  const addRightPanels = useCallback(
    (api: DockviewApi, widthOverride?: number) => {
      const desiredWidth =
        widthOverride ??
        readStoredSize(CENTER_STORAGE_KEY_RIGHT_WIDTH) ??
        initialRightWidthRef.current;
      const tabs = rightTabsRef.current;
      isMutatingRightRef.current = true;
      return withCleanupSync(
        () => {
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
          } else if (hasStandaloneRight) {
            const panel = api.addPanel({
              id: PANEL_RIGHT,
              component: PANEL_RIGHT,
              title: 'Right',
              position: { direction: 'right' },
              initialWidth: desiredWidth,
            });
            hidePanelHeader(panel);
          }
        },
        () => {
          isMutatingRightRef.current = false;
        },
      );
    },
    [activeRightTabRef, hasStandaloneRight, initialRightWidthRef, rightTabsRef],
  );

  const removeRightPanels = useCallback((api: DockviewApi) => {
    isMutatingRightRef.current = true;
    return withCleanupSync(
      () => {
        closeRightPanels(api);
      },
      () => {
        isMutatingRightRef.current = false;
      },
    );
  }, []);

  return {
    isAnimatingRef,
    isMutatingRightRef,
    addRightPanels,
    removeRightPanels,
  };
}

export type CenterRightPanelOps = ReturnType<typeof useCenterRightPanelOps>;
