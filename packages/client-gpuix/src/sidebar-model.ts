import { formatCompactElapsed } from '@funny/client-core';
import type { ThreadItemStatus } from '@funny/gpuix-ui/sidebar';
import type { Thread } from '@funny/shared';

const SIDEBAR_ACTIVITY_LIMIT = 6;
const SIDEBAR_PROJECT_THREAD_LIMIT = 5;

export function sidebarThreadStatus(status: Thread['status']): ThreadItemStatus {
  switch (status) {
    case 'setting_up':
    case 'pending':
      return 'setting-up';
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function recentSidebarThreads(
  threads: readonly Thread[],
  limit = SIDEBAR_ACTIVITY_LIMIT,
): Thread[] {
  return threads
    .filter((thread) => !thread.archived)
    .toSorted((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))
    .slice(0, limit);
}

export function visibleProjectThreads(
  threads: readonly Thread[],
  limit = SIDEBAR_PROJECT_THREAD_LIMIT,
): Thread[] {
  return threads
    .filter((thread) => !thread.archived)
    .toSorted((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return timestamp(right.updatedAt) - timestamp(left.updatedAt);
    })
    .slice(0, limit);
}

export function formatSidebarRelativeTime(value: string | undefined, now = Date.now()): string {
  const then = timestamp(value);
  if (then === 0) return '';
  return formatCompactElapsed(then, now);
}

export function sidebarThreadSummary(thread: Thread): string {
  if (thread.lastAssistantMessage?.trim()) {
    const compact = thread.lastAssistantMessage.replace(/\s+/g, ' ').trim();
    return compact.length > 72 ? `${compact.slice(0, 71).trimEnd()}…` : compact;
  }
  if (thread.status === 'running') return 'Running…';
  if (thread.status === 'waiting') return 'Waiting for input';
  if (thread.status === 'failed') return 'Run failed';
  if (thread.status === 'setting_up' || thread.status === 'pending') return 'Setting up…';
  if (thread.status === 'completed') return 'Completed';
  return '';
}
