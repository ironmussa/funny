import type { MessageListScrollAnchor } from './MemoizedMessageList';

export const LOAD_MORE_THRESHOLD_PX = 200;
export const STICKY_BOTTOM_THRESHOLD_PX = 80;
// After a thread switch the virtualized list re-measures row heights over
// several frames, firing scroll events (clamps, content growth) that carry no
// user intent. Scroll events inside this window are treated as layout noise.
export const THREAD_SWITCH_SETTLE_MS = 700;

export type MessageStreamScrollMessage = {
  id: string;
  role?: string;
  content?: string;
  toolCalls?: unknown[];
};

export type ThreadScrollPosition = {
  scrollProgress: number;
  atBottom: boolean;
  userHasScrolledUp: boolean;
  anchor: MessageListScrollAnchor | null;
};

export type ScrollRestoreOutcome = 'skipped' | 'bottom' | 'anchor' | 'progress';

type PaginationProgressState = {
  hasPagination: boolean;
  loadedCount: number;
  paginationTotal?: number;
  paginationWindowStart?: number;
};

export function getDistanceFromBottom(
  viewport: HTMLDivElement,
  metrics: { scrollHeight: number; clientHeight: number } = viewport,
) {
  return Math.max(0, metrics.scrollHeight - viewport.scrollTop - metrics.clientHeight);
}

function getScrollProgress(viewport: HTMLDivElement) {
  const scrollableRange = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  if (scrollableRange <= 0) return 1;
  return Math.min(1, Math.max(0, viewport.scrollTop / scrollableRange));
}

function clampProgress(progress: number) {
  return Math.min(1, Math.max(0, progress));
}

export function getThreadScrollProgress(
  viewport: HTMLDivElement,
  { hasPagination, loadedCount, paginationTotal, paginationWindowStart }: PaginationProgressState,
) {
  const localProgress = getScrollProgress(viewport);
  if (
    !hasPagination ||
    typeof paginationTotal !== 'number' ||
    paginationTotal <= 1 ||
    loadedCount <= 0 ||
    typeof paginationWindowStart !== 'number'
  ) {
    return localProgress;
  }

  const loadedSpan = Math.max(0, loadedCount - 1);
  const globalMessageIndex = paginationWindowStart + localProgress * loadedSpan;
  return clampProgress(globalMessageIndex / Math.max(1, paginationTotal - 1));
}

export function getLocalScrollProgress(
  threadProgress: number,
  { hasPagination, loadedCount, paginationTotal, paginationWindowStart }: PaginationProgressState,
) {
  if (
    !hasPagination ||
    typeof paginationTotal !== 'number' ||
    paginationTotal <= 1 ||
    loadedCount <= 1 ||
    typeof paginationWindowStart !== 'number'
  ) {
    return clampProgress(threadProgress);
  }

  const targetMessageIndex = clampProgress(threadProgress) * Math.max(1, paginationTotal - 1);
  return clampProgress((targetMessageIndex - paginationWindowStart) / Math.max(1, loadedCount - 1));
}

export function getFirstMessageId(messages: readonly MessageStreamScrollMessage[]) {
  return messages[0]?.id ?? null;
}

export function getLastMessage(messages: readonly MessageStreamScrollMessage[]) {
  return messages.length > 0 ? messages[messages.length - 1] : undefined;
}

export function getLastUserMessageId(messages: readonly MessageStreamScrollMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user') return message.id;
  }
  return null;
}

export function getLastVisibleUserMessageId(messages: readonly MessageStreamScrollMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user' && message.content?.trim()) return message.id;
  }
  return null;
}
