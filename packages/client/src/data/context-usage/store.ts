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

/** Add the run's provider, model and reported context size to a row, when known. */
function setRunScope(
  row: ContextUsage,
  provider: ContextUsage['provider'],
  model: string | undefined,
  maxTokens: number | undefined,
): void {
  if (provider) row.provider = provider;
  if (model) row.model = model;
  if (maxTokens) row.maxTokens = maxTokens;
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
  const prev = getContextUsageStore(layer).getSynced(threadId);
  // A snapshot from another provider or model describes another context size:
  // carry its breakdown and size forward only while the run stays the same.
  const sameRun =
    !!prev &&
    (!data.provider || !prev.provider || prev.provider === data.provider) &&
    (!data.model || !prev.model || prev.model === data.model);
  const breakdown = data.breakdown ?? (sameRun ? prev?.breakdown : undefined);
  const provider = data.provider ?? (sameRun ? prev?.provider : undefined);
  const model = data.model ?? (sameRun ? prev?.model : undefined);
  const maxTokens = data.maxTokens ?? (sameRun ? prev?.maxTokens : undefined);
  const row: ContextUsage = {
    cumulativeInputTokens: data.cumulativeInputTokens,
    lastInputTokens: data.inputTokens,
    lastOutputTokens: data.outputTokens,
    breakdown: breakdown || undefined,
  };
  setRunScope(row, provider, model, maxTokens);
  return write(threadId, row, layer);
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
  const prev = getContextUsageStore(layer).getSynced(threadId);
  const row: ContextUsage = {
    cumulativeInputTokens: postTokens,
    lastInputTokens: postTokens,
    lastOutputTokens: 0,
  };
  // Compaction shrinks the context, not its limit: keep the run's scope.
  setRunScope(row, prev?.provider, prev?.model, prev?.maxTokens);
  return write(threadId, row, layer);
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
