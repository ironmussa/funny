import type { Project, Thread } from '@funny/shared';

import type { ThreadNavigationState } from './thread-navigation';
import type {
  PortableMessage,
  PortablePermissionState,
  ThreadWorkspaceState,
} from './thread-workspace';
import type { StoreApi } from './vanilla-store';

export function selectProjects(state: ThreadNavigationState): Project[] {
  return state.projectIds.map((id) => state.projectsById[id]).filter(Boolean);
}

export function selectProjectThreads(state: ThreadNavigationState, projectId: string): Thread[] {
  return (state.threadIdsByProject[projectId] ?? [])
    .map((id) => state.threadsById[id])
    .filter(Boolean);
}

export function selectSelectedThreadId(state: ThreadWorkspaceState): string | null {
  return state.selectedThreadId;
}

export function selectSelectedPermission(
  state: ThreadWorkspaceState,
): PortablePermissionState | null {
  if (!state.selectedThreadId) return null;
  return state.byThreadId[state.selectedThreadId]?.permission ?? null;
}

export function createThreadMessagesSelector(threadId: string) {
  let previousData: ThreadWorkspaceState['byThreadId'][string] | undefined;
  let previousResult: PortableMessage[] = [];
  return (state: ThreadWorkspaceState): PortableMessage[] => {
    const data = state.byThreadId[threadId];
    if (data === previousData) return previousResult;
    previousData = data;
    previousResult = data ? data.messageIds.map((id) => data.messagesById[id]).filter(Boolean) : [];
    return previousResult;
  };
}

export function subscribeSelector<TState, TSlice>(options: {
  store: StoreApi<TState>;
  selector(state: TState): TSlice;
  listener(value: TSlice, previous: TSlice): void;
  equal?: (left: TSlice, right: TSlice) => boolean;
}): () => void {
  let current = options.selector(options.store.getState());
  return options.store.subscribe((state) => {
    const next = options.selector(state);
    if ((options.equal ?? Object.is)(current, next)) return;
    const previous = current;
    current = next;
    options.listener(next, previous);
  });
}
