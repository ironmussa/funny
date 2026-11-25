/**
 * Facade that combines project-store, thread-store, and ui-store, kept for tests
 * and stories (`useAppStore.setState` seeds all three). Production code must
 * select from the individual stores: this hook subscribes to all three and
 * rebuilds the combined state on every change, i.e. every streaming flush.
 * `scripts/fitness/check-client-data-layer.ts` fails on a production import.
 *
 * Optimized: Uses useSyncExternalStore to subscribe to all three stores but only
 * triggers re-renders when the selector result changes (shallow equality check).
 */
import { useSyncExternalStore, useCallback } from 'react';

import { useProjectStore } from './project-store';
import { useThreadStore } from './thread-store';
import { useUIStore } from './ui-store';

// Combined state type for backward compatibility
type CombinedState = ReturnType<typeof useProjectStore.getState> &
  ReturnType<typeof useThreadStore.getState> &
  ReturnType<typeof useUIStore.getState>;

// Cache the combined state to avoid creating a new spread object on every
// getSnapshot call. Rebuilt lazily when any underlying store changes.
let cachedCombined: CombinedState | null = null;
let storeVersion = 0;
let cachedVersion = -1;

// Subscribe at module level to invalidate cache on any store change
useProjectStore.subscribe(() => {
  storeVersion++;
  cachedCombined = null;
});
useThreadStore.subscribe(() => {
  storeVersion++;
  cachedCombined = null;
});
useUIStore.subscribe(() => {
  storeVersion++;
  cachedCombined = null;
});

function getCombinedState(): CombinedState {
  if (cachedCombined !== null && cachedVersion === storeVersion) {
    return cachedCombined;
  }
  cachedCombined = {
    ...useProjectStore.getState(),
    ...useThreadStore.getState(),
    ...useUIStore.getState(),
  };
  cachedVersion = storeVersion;
  return cachedCombined;
}

/** Subscribe to all three stores, calling `onStoreChange` when any one changes. */
function subscribeToCombined(onStoreChange: () => void): () => void {
  const unsub1 = useProjectStore.subscribe(onStoreChange);
  const unsub2 = useThreadStore.subscribe(onStoreChange);
  const unsub3 = useUIStore.subscribe(onStoreChange);
  return () => {
    unsub1();
    unsub2();
    unsub3();
  };
}

/**
 * Combined hook that selects from all three stores.
 * Uses useSyncExternalStore for proper React 18+ concurrent-mode support.
 * Only re-renders when the selected value changes (referential equality).
 */
export function useAppStore<T>(selector: (state: CombinedState) => T): T {
  const getSnapshot = useCallback(() => selector(getCombinedState()), [selector]);

  return useSyncExternalStore(subscribeToCombined, getSnapshot, getSnapshot);
}

// Imperative getState() for use-ws.ts and use-route-sync.ts
useAppStore.getState = getCombinedState;

const PROJECT_KEYS = new Set([
  'projects',
  'expandedProjects',
  'selectedProjectId',
  'initialized',
  'loadProjects',
  'toggleProject',
  'selectProject',
  'deleteProject',
  'reorderProjects',
  'renameProject',
]);
const THREAD_KEYS = new Set([
  'selectedThreadId',
  'activeThread',
  'loadThreadsForProject',
  'selectThread',
  'archiveThread',
  'pinThread',
  'deleteThread',
  'appendOptimisticMessage',
  'refreshActiveThread',
  'refreshAllLoadedThreads',
  'clearProjectThreads',
  'handleWSInit',
  'handleWSMessage',
  'handleWSToolCall',
  'handleWSToolOutput',
  'handleWSStatus',
  'handleWSResult',
  'handleWSQueueUpdate',
]);

// setState support for tests
useAppStore.setState = (partial: Partial<CombinedState>) => {
  const entries = Object.entries(partial);
  const isThreadKey = (key: string) => !PROJECT_KEYS.has(key) && THREAD_KEYS.has(key);
  const projectPartial = Object.fromEntries(entries.filter(([key]) => PROJECT_KEYS.has(key)));
  const threadPartial = Object.fromEntries(entries.filter(([key]) => isThreadKey(key)));
  const uiPartial = Object.fromEntries(
    entries.filter(([key]) => !PROJECT_KEYS.has(key) && !THREAD_KEYS.has(key)),
  );

  // Every value comes from `partial`, a Partial<CombinedState>, and zustand's setState only
  // shallow-merges it; this helper exists only for tests and stories.
  if (Object.keys(projectPartial).length > 0) useProjectStore.setState(projectPartial);
  if (Object.keys(threadPartial).length > 0) useThreadStore.setState(threadPartial);
  if (Object.keys(uiPartial).length > 0) useUIStore.setState(uiPartial);
};
