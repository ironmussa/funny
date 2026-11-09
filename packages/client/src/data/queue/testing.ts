import type { QueuedMessage } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { getQueueStore } from './store';

interface SeededQueue {
  count: number;
  next?: string;
  /** A loaded list. Without `stale`, it is current, so nothing is fetched. */
  messages?: QueuedMessage[];
  /** The list is behind the summary: the composer refetches it. */
  stale?: boolean;
}

/** Make `queues` the session's queue rows (tests and stories). */
export function seedQueues(
  queues: Record<string, SeededQueue>,
  layer: DataLayer = getDataLayer(),
): void {
  getQueueStore(layer).replaceAll(
    Object.entries(queues).map(([id, { count, next, messages, stale }]) => ({
      id,
      count,
      next: next ?? messages?.[0]?.content,
      messages,
      rev: 1,
      loadedRev: messages && !stale ? 1 : 0,
    })),
  );
}
