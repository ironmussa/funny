import { useThreadStore } from '@/stores/thread-store';
import { getUrlThreadId } from '@/stores/thread-store-internals';

export type ThreadStoreState = ReturnType<typeof useThreadStore.getState>;

export function notifyReviewDirty(threadId: string): void {
  import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
    useReviewPaneStore.getState().notifyDirty(threadId);
  });
}

/** True when `threadId` is the thread the user is currently viewing. */
export function isViewingThread(store: ThreadStoreState, threadId: string): boolean {
  return (getUrlThreadId() ?? store.selectedThreadId) === threadId;
}
