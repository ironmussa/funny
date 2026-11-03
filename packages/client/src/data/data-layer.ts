import type { QueryClient } from '@tanstack/query-core';

import { createClientLogger } from '@/lib/client-logger';

import { createDataQueryClient } from './query-client';

const log = createClientLogger('data-layer');

/**
 * One per authenticated session. Owns every client collection and the
 * request cache that feeds them, so a session swap (logout, user switch)
 * drops all server-backed entity state in one step.
 *
 * Entity modules attach their resources lazily through `own()`. That way
 * the layer does not import every entity (no cycles), and a session that
 * never opens Kanban never builds the Kanban collections.
 */
export interface DataLayer {
  /** The user this layer belongs to, or `null` before login. */
  readonly userId: string | null;
  /** The active organization (`null` = personal). Server lists are org-scoped. */
  readonly orgId: string | null;
  readonly queryClient: QueryClient;
  /** Aborted on `dispose()`. Every loader passes it (merged) into its request. */
  readonly signal: AbortSignal;
  /** True after `dispose()`. Writers check it before every synced write. */
  readonly disposed: boolean;
  /**
   * Monotonic sequence for write fencing (see `threads/fencing.ts`).
   * Scoped to the layer so a new session starts from zero.
   */
  nextSeq(): number;
  /**
   * Return the resource registered under `key`, creating it on first use.
   * The resource's `dispose` runs when the layer is disposed.
   */
  own<T>(key: string, create: () => OwnedResource<T>): T;
  dispose(): void;
}

export interface OwnedResource<T> {
  value: T;
  dispose?: () => void;
}

export interface CreateDataLayerOptions {
  userId: string | null;
  orgId?: string | null;
  queryClient?: QueryClient;
}

export function createDataLayer({
  userId,
  orgId = null,
  queryClient,
}: CreateDataLayerOptions): DataLayer {
  const client = queryClient ?? createDataQueryClient();
  const controller = new AbortController();
  const owned = new Map<string, OwnedResource<unknown>>();
  let seq = 0;
  let disposed = false;

  const layer: DataLayer = {
    userId,
    orgId,
    queryClient: client,
    signal: controller.signal,
    get disposed() {
      return disposed;
    },
    nextSeq() {
      seq += 1;
      return seq;
    },
    own<T>(key: string, create: () => OwnedResource<T>): T {
      if (disposed) throw new Error(`DataLayer disposed; cannot create "${key}"`);
      const existing = owned.get(key);
      if (existing) return existing.value as T;
      const resource = create();
      owned.set(key, resource);
      return resource.value;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const [key, resource] of owned) {
        try {
          resource.dispose?.();
        } catch (error) {
          log.warn('owned resource dispose failed', { key, error: String(error) });
        }
      }
      owned.clear();
      void client.cancelQueries();
      client.clear();
    },
  };
  return layer;
}

/** Combine the layer's lifetime signal with a per-request signal (e.g. query-core's). */
export function layerRequestSignal(layer: DataLayer, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([layer.signal, signal]) : layer.signal;
}
