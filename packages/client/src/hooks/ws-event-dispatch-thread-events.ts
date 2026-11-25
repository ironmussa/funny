import type { WSThreadDeletedData } from '@funny/shared';
import { startTransition } from 'react';

import { applyJobEvent, applyWatcherEvent } from '@/data/background/loaders';
import { applyCommentAdded, applyCommentDeleted } from '@/data/comments/store';
import { buildPath } from '@/lib/url';
import { clientComposition } from '@/platform/client-composition';
import * as threadMutations from '@/stores/thread-mutations';
import { patchThreadRow } from '@/stores/thread-row-writes';
import { useThreadStore } from '@/stores/thread-store';
import { getNavigate } from '@/stores/thread-store-internals';

import { isViewingThread } from './ws-event-dispatch-shared';

// Thread, presence, pipeline and background-entity realtime handlers.

/** Bump a thread's comment-count badge live (floored at 0). */
function adjustCommentCount(threadId: string, delta: number): void {
  patchThreadRow(threadId, (t) => ({
    ...t,
    commentCount: Math.max(0, (t.commentCount ?? 0) + delta),
  }));
}

export function upsertWatcher(_threadId: string, data: any): void {
  if (data?.watcher) applyWatcherEvent(data.watcher);
}

export function upsertJob(_threadId: string, data: any): void {
  if (data?.job) applyJobEvent(data.job);
}

type PipelineStoreState = ReturnType<
  (typeof import('@/stores/pipeline-store'))['usePipelineStore']['getState']
>;
export function withPipelineStore(apply: (store: PipelineStoreState) => void): void {
  import('@/stores/pipeline-store').then(({ usePipelineStore }) => {
    apply(usePipelineStore.getState());
  });
}

type PresenceStoreState = ReturnType<
  (typeof import('@/stores/presence-store'))['usePresenceStore']['getState']
>;
export function withPresenceStore(apply: (store: PresenceStoreState) => void): void {
  import('@/stores/presence-store').then(({ usePresenceStore }) => {
    apply(usePresenceStore.getState());
  });
}

export function handleThreadCreated(_threadId: string, data: any): void {
  // Scratch threads have no project (projectId is '' / null). Calling
  // loadThreadsForProject('') would fall through to api.listThreads()
  // with no filter, leaking every user thread into threadsByProject['']
  // and duplicating the sidebar Activity section. Scratch threads are
  // handled separately via addScratchThread on the create path.
  if (data.projectId) {
    useThreadStore.getState().loadThreadsForProject(data.projectId);
  }
}

export function handleThreadComment(threadId: string, data: any): void {
  // A new comment was posted — append it live for every current viewer and
  // bump the header badge. See thread-sharing design D9.
  if (data.comment) {
    applyCommentAdded(data.comment);
    adjustCommentCount(threadId, +1);
  }
}

export function handleThreadCommentDeleted(threadId: string, data: any): void {
  if (data.commentId) {
    applyCommentDeleted(data.commentId);
    adjustCommentCount(threadId, -1);
    return;
  }
  // Legacy payload without an id — fall back to a refetch.
  const store = useThreadStore.getState();
  if (isViewingThread(store, threadId)) {
    store.refreshActiveThread();
  }
}

export function handleThreadStageChanged(threadId: string, data: any): void {
  useThreadStore.getState().handleWSStageChanged(threadId, {
    fromStage: data.fromStage ?? null,
    toStage: data.toStage,
    projectId: data.projectId,
  });
}

/** A field that moves the thread; `null` counts (a removed worktree clears its path and branch). */
const LOCATION_FIELDS = [
  'branch',
  'baseBranch',
  'worktreePath',
  'containerUrl',
  'mergedAt',
  'mode',
];

function hasLocationChange(data: any): boolean {
  return LOCATION_FIELDS.some((field) => data[field] !== undefined);
}

function patchPermissionMode(threadId: string, permissionMode: any): void {
  patchThreadRow(threadId, (thread) => ({ ...thread, permissionMode }));
  // Payloads opened before their row exists (a very early event) keep their own copy.
  useThreadStore.setState((state) =>
    threadMutations.applyThreadDataPatch(state, threadId, (thread) => ({
      ...thread,
      permissionMode,
    })),
  );
}

export function handleThreadUpdated(threadId: string, data: any): void {
  const store = useThreadStore.getState();
  if (data.resync && isViewingThread(store, threadId)) {
    store.refreshActiveThread();
  }
  if (data.status) {
    store.handleWSStatus(threadId, { status: data.status });
  }
  if (data.archived) {
    store.refreshAllLoadedThreads();
  }
  if (hasLocationChange(data)) {
    store.refreshAllLoadedThreads();
    if (isViewingThread(store, threadId)) {
      store.refreshActiveThread();
    }
  }
  if (data.permissionMode) {
    patchPermissionMode(threadId, data.permissionMode);
  }
}

export function handlePresenceJoin(threadId: string, data: any): void {
  if (data.viewer) {
    withPresenceStore((store) => store.upsertViewer(threadId, data.viewer));
  }
}

export function handleShareRevoked(threadId: string): void {
  // The owner revoked our access — drop the thread + its presence.
  withPresenceStore((store) => store.clearThread(threadId));
  useThreadStore.getState().handleShareRevoked(threadId);
}

export function handleThreadDeleted(
  threadId: string,
  data: Partial<WSThreadDeletedData> | undefined,
): void {
  // Deleted here, in another tab, or by another client (spec: thread deleted
  // elsewhere): drop it from every list and leave its detail view if open.
  const wasOpen = clientComposition.platform.navigation.current().pathname.includes(threadId);
  withPresenceStore((store) => store.clearThread(threadId));
  useThreadStore.getState().handleThreadDeleted(threadId);
  if (!wasOpen) return;
  const navigate = getNavigate();
  const projectId = data?.projectId;
  navigate?.(buildPath(projectId ? `/projects/${projectId}` : '/'));
}

export function handleThreadEvent(threadId: string, data: any) {
  startTransition(() => {
    const active = useThreadStore.getState().activeThread;
    if (active && active.id === threadId) {
      const existing = active.threadEvents ?? [];
      if (data.event?.id && existing.some((e: any) => e.id === data.event.id)) return;
      useThreadStore.setState({
        activeThread: {
          ...active,
          threadEvents: [...existing, data.event],
        },
      });
    }
  });
}

export function handleRunnerStatus(data: any) {
  const status = data?.status;
  if (status !== 'online' && status !== 'offline') return;
  import('@/stores/runner-status-store').then(({ useRunnerStatusStore }) => {
    useRunnerStatusStore.getState().setStatus(status);
  });
}
