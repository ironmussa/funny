/**
 * Backward-compatible facade that combines project-store, thread-store, and ui-store.
 * Components should gradually migrate to importing from the individual stores directly.
 *
 * Optimized: Uses useSyncExternalStore to subscribe to all three stores but only
 * triggers re-renders when the selector result changes (shallow equality check).
 */
import { useSyncExternalStore, useRef, useCallback } from 'react';
import { useProjectStore } from './project-store';
import { useThreadStore } from './thread-store';
import { useUIStore } from './ui-store';

export { setAppNavigate } from './thread-store';
export type { ThreadWithMessages, AgentInitInfo, AgentResultInfo } from './thread-store';

// Combined state type for backward compatibility
type CombinedState = ReturnType<typeof useProjectStore.getState> &
  ReturnType<typeof useThreadStore.getState> &
  ReturnType<typeof useUIStore.getState>;

// Cache the combined state to avoid creating a new spread object on every
// getSnapshot call. Rebuilt lazily when any underlying store changes.
let _cachedCombined: CombinedState | null = null;
let _storeVersion = 0;
let _cachedVersion = -1;

// Subscribe at module level to invalidate cache on any store change
useProjectStore.subscribe(() => { _storeVersion++; _cachedCombined = null; });
useThreadStore.subscribe(() => { _storeVersion++; _cachedCombined = null; });
useUIStore.subscribe(() => { _storeVersion++; _cachedCombined = null; });

function getCombinedState(): CombinedState {
  if (_cachedCombined !== null && _cachedVersion === _storeVersion) {
    return _cachedCombined;
  }
  _cachedCombined = {
    ...useProjectStore.getState(),
    ...useThreadStore.getState(),
    ...useUIStore.getState(),
  } as CombinedState;
  _cachedVersion = _storeVersion;
  return _cachedCombined;
}

/** Subscribe to all three stores, calling `onStoreChange` when any one changes. */
function subscribeToCombined(onStoreChange: () => void): () => void {
  const unsub1 = useProjectStore.subscribe(onStoreChange);
  const unsub2 = useThreadStore.subscribe(onStoreChange);
  const unsub3 = useUIStore.subscribe(onStoreChange);
  return () => { unsub1(); unsub2(); unsub3(); };
}

/**
 * Combined hook that selects from all three stores.
 * Uses useSyncExternalStore for proper React 18+ concurrent-mode support.
 * Only re-renders when the selected value changes (referential equality).
 */
export function useAppStore<T>(selector: (state: CombinedState) => T): T {
  // Memoize selector result to prevent unnecessary re-renders
  const prevRef = useRef<{ value: T } | null>(null);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const getSnapshot = useCallback(() => {
    const next = selectorRef.current(getCombinedState());
    if (prevRef.current !== null && Object.is(prevRef.current.value, next)) {
      return prevRef.current.value;
    }
    prevRef.current = { value: next };
    return next;
  }, []);

  return useSyncExternalStore(subscribeToCombined, getSnapshot, getSnapshot);
}

// Imperative getState() for use-ws.ts and use-route-sync.ts
useAppStore.getState = getCombinedState;

// setState support for tests
useAppStore.setState = (partial: Partial<CombinedState>) => {
  const projectKeys = ['projects', 'expandedProjects', 'selectedProjectId', 'initialized', 'loadProjects', 'toggleProject', 'selectProject', 'deleteProject', 'reorderProjects', 'renameProject'];
  const threadKeys = ['threadsByProject', 'selectedThreadId', 'activeThread', 'loadThreadsForProject', 'selectThread', 'archiveThread', 'pinThread', 'deleteThread', 'appendOptimisticMessage', 'refreshActiveThread', 'refreshAllLoadedThreads', 'clearProjectThreads', 'handleWSInit', 'handleWSMessage', 'handleWSToolCall', 'handleWSToolOutput', 'handleWSStatus', 'handleWSResult', 'handleWSQueueUpdate'];

  const projectPartial: Record<string, any> = {};
  const threadPartial: Record<string, any> = {};
  const uiPartial: Record<string, any> = {};

  for (const [key, value] of Object.entries(partial)) {
    if (projectKeys.includes(key)) {
      projectPartial[key] = value;
    } else if (threadKeys.includes(key)) {
      threadPartial[key] = value;
    } else {
      uiPartial[key] = value;
    }
  }

  if (Object.keys(projectPartial).length > 0) useProjectStore.setState(projectPartial as any);
  if (Object.keys(threadPartial).length > 0) useThreadStore.setState(threadPartial as any);
  if (Object.keys(uiPartial).length > 0) useUIStore.setState(uiPartial as any);
};
