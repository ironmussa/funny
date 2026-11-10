import type { ContextUsage } from '@/lib/context-usage-types';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { getContextUsageStore } from './store';

/** Make `usageByThread` the session's context usage (tests and stories). */
export function seedContextUsage(
  usageByThread: Record<string, ContextUsage>,
  layer: DataLayer = getDataLayer(),
): void {
  getContextUsageStore(layer).replaceAll(
    Object.entries(usageByThread).map(([id, usage]) => ({ ...usage, id })),
  );
}
