import type { ThreadNavigationState, ThreadWorkspaceState } from '@funny/client-core';

export function selectThreadWorkspaceData(state: ThreadWorkspaceState, threadId: string) {
  return state.byThreadId[threadId];
}

export function selectThreadRun(state: ThreadWorkspaceState, threadId: string) {
  return state.byThreadId[threadId]?.run;
}

export function selectThreadPermission(state: ThreadWorkspaceState, threadId: string) {
  return state.byThreadId[threadId]?.permission ?? null;
}

export function selectThreadRecord(state: ThreadNavigationState, threadId: string) {
  return state.threadsById[threadId];
}

export function selectThreadViewerShareLevel(state: ThreadNavigationState, threadId: string) {
  return state.threadsById[threadId]?.viewerShareLevel;
}

export function selectProjectName(
  state: ThreadNavigationState,
  projectId: string | undefined,
): string | undefined {
  return projectId ? state.projectsById[projectId]?.name : undefined;
}
