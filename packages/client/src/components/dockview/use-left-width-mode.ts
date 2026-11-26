import type { DockviewApi } from 'dockview-react';
import { type MutableRefObject, useEffect, useRef } from 'react';

import { readStoredSize, writeStoredSize } from './layout-storage';

/** Where the left edge group's width is remembered, and its width when nothing is. */
export interface LeftWidthMode {
  storageKey: string;
  defaultWidth: number;
}

/** Narrower than this is the collapsed strip or a transient size, never a width to keep. */
const MIN_SAVED_WIDTH = 120;

/**
 * Lets each thing the left sidebar shows keep its own width (the thread list
 * narrow, the factory queue wide).
 *
 * Dockview does not fire `onDidLayoutChange` when the user drags the edge
 * group's sash, so the width is saved from the group's own dimension events,
 * under the current mode. On a mode change the group is resized to the
 * incoming mode's width.
 *
 * Returns the storage key of the current mode (the layout persister writes
 * the left width under it too).
 */
export function useLeftWidthMode(
  apiRef: MutableRefObject<DockviewApi | null>,
  mode: LeftWidthMode,
): MutableRefObject<string> {
  const keyRef = useRef(mode.storageKey);
  const appliedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const group = apiRef.current?.getEdgeGroup('left');
    if (!group) return;
    const subscription = group.onDidDimensionsChange(({ width }) => {
      if (group.isCollapsed() || width < MIN_SAVED_WIDTH) return;
      writeStoredSize(keyRef.current, width);
    });
    return () => subscription.dispose();
  }, [apiRef]);

  useEffect(() => {
    const api = apiRef.current;
    const previous = appliedKeyRef.current;
    if (!api || previous === mode.storageKey) return;
    appliedKeyRef.current = mode.storageKey;
    const group = api.getEdgeGroup('left');
    const expanded = !!group && !group.isCollapsed();
    // The outgoing mode's width is already saved by the dimension listener;
    // `group.width` may lag a resize still being applied, so it is not read here.
    keyRef.current = mode.storageKey;
    if (!expanded) return;
    // On mount the restored layout already holds the width; only a width
    // stored for this mode overrides it. On a switch, a mode never sized
    // takes its default.
    const width = readStoredSize(mode.storageKey) ?? (previous === null ? null : mode.defaultWidth);
    if (width !== null && width !== group.width) group.setSize({ width });
  }, [apiRef, mode.storageKey, mode.defaultWidth]);

  return keyRef;
}
