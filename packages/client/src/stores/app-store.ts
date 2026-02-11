/**
 * Backward-compatible facade that combines project-store, thread-store, and ui-store.
 * Components should gradually migrate to importing from the individual stores directly.
 */
import { useProjectStore } from './project-store';
import { useThreadStore } from './thread-store';
import { useUIStore } from './ui-store';

export { setAppNavigate } from './thread-store';
export type { ThreadWithMessages, AgentInitInfo, AgentResultInfo } from './thread-store';

// Combined state type for backward compatibility
type CombinedState = ReturnType<typeof useProjectStore.getState> &
  ReturnType<typeof useThreadStore.getState> &
  ReturnType<typeof useUIStore.getState>;

/**
 * Combined hook that merges all three stores.
 * NOTE: This subscribes to all three stores, so any change triggers re-render.
 * Migrate to useProjectStore/useThreadStore/useUIStore for better performance.
 */
export function useAppStore<T>(selector: (state: CombinedState) => T): T {
  const p = useProjectStore();
  const t = useThreadStore();
  const u = useUIStore();
  return selector({ ...p, ...t, ...u } as CombinedState);
}

// Imperative getState() for use-ws.ts and use-route-sync.ts
useAppStore.getState = (): CombinedState => ({
  ...useProjectStore.getState(),
  ...useThreadStore.getState(),
  ...useUIStore.getState(),
} as CombinedState);

// setState support for tests
useAppStore.setState = (partial: Partial<CombinedState>) => {
  const projectKeys = ['projects', 'expandedProjects', 'selectedProjectId', 'initialized', 'loadProjects', 'toggleProject', 'selectProject', 'deleteProject', 'reorderProjects', 'renameProject'];
  const threadKeys = ['threadsByProject', 'selectedThreadId', 'activeThread', 'loadThreadsForProject', 'selectThread', 'archiveThread', 'pinThread', 'deleteThread', 'appendOptimisticMessage', 'refreshActiveThread', 'refreshAllLoadedThreads', 'clearProjectThreads', 'handleWSInit', 'handleWSMessage', 'handleWSToolCall', 'handleWSToolOutput', 'handleWSStatus', 'handleWSResult'];

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
