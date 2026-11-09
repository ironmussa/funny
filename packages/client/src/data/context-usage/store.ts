import type { WSContextUsageData } from '@funny/shared';

import type { ContextUsage } from '@/lib/context-usage-types';

import type { DataLayer } from '../data-layer';
import { createEntityStore, type EntityStore } from '../entities';
import { getDataLayer } from '../runtime';

/**
 * Context usage per thread, keyed by thread id. The runtime keeps usage
 * in memory only and pushes it over WS (`agent:context_usage`,
 * `agent:compact_boundary`); there is no endpoint to fetch it. So the rows are
 * fed by those events alone. Persisting across reloads is the caller's job:
 * writers return the row they wrote, and `restoreContextUsage` takes a
 * snapshot loaded from browser storage.
 */

export type ContextUsageRow = ContextUsage & { id: string };

export function getContextUsageStore(
  layer: DataLayer = getDataLayer(),
): EntityStore<ContextUsageRow> {
  return layer.own('context-usage', () => {
    const store = createEntityStore<ContextUsageRow>(layer, 'context-usage');
    return {
      value: store,
      dispose: () => {
        void store.collection.cleanup({ dependents: true }).catch(() => undefined);
      },
    };
  });
}

function write(threadId: string, usage: ContextUsage, layer: DataLayer): ContextUsage {
  getContextUsageStore(layer).upsert([{ ...usage, id: threadId }]);
  return usage;
}

/**
 * Apply an `agent:context_usage` event. Per-message events carry no
 * breakdown; keep the last end-of-turn snapshot until the next one replaces it.
 */
export function applyContextUsageEvent(
  threadId: string,
  data: WSContextUsageData,
  layer: DataLayer = getDataLayer(),
): ContextUsage {
  const breakdown = data.breakdown ?? getContextUsageStore(layer).getSynced(threadId)?.breakdown;
  return write(
    threadId,
    {
      cumulativeInputTokens: data.cumulativeInputTokens,
      lastInputTokens: data.inputTokens,
      lastOutputTokens: data.outputTokens,
      ...(breakdown ? { breakdown } : {}),
    },
    layer,
  );
}

/**
 * Mirror the runtime's reset after a compaction: the context is now the
 * summary, of `postTokens` (0 when the SDK did not report it). The breakdown
 * describes the pre-compaction context, so it is dropped.
 */
export function resetContextUsage(
  threadId: string,
  postTokens: number,
  layer: DataLayer = getDataLayer(),
): ContextUsage {
  return write(
    threadId,
    { cumulativeInputTokens: postTokens, lastInputTokens: postTokens, lastOutputTokens: 0 },
    layer,
  );
}

/**
 * Restore a thread's row from a persisted snapshot when the session has none
 * yet. `load` only runs in that case.
 */
export function restoreContextUsage(
  threadId: string,
  load: () => ContextUsage | undefined,
  layer: DataLayer = getDataLayer(),
): void {
  const store = getContextUsageStore(layer);
  if (store.getSynced(threadId)) return;
  const stored = load();
  if (stored) store.upsert([{ ...stored, id: threadId }]);
}
