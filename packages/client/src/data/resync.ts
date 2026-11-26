import type { Query } from '@tanstack/query-core';

import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from './data-layer';
import { getDataLayer } from './runtime';
import { isThreadRecapQueryKey } from './thread-recap/queries';

const log = createClientLogger('data-resync');

/**
 * Session-wide sources that loaders keep filled without a mounted reader, so
 * they must be refetched even when no component observes their query.
 */
const SESSION_SOURCES = new Set([
  'projects',
  'agent-templates',
  'jobs',
  'watchers',
  'activities',
  'automation-inbox',
  'runner-providers',
  'sandbox-connections',
]);

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function shouldResync(query: Query): boolean {
  if (isThreadRecapQueryKey(query.queryKey)) return false;
  if (query.getObserversCount() > 0) return true;
  const root = query.queryKey[0];
  return isString(root) && SESSION_SOURCES.has(root) && query.state.data !== undefined;
}

/**
 * Refetch every loaded source after the realtime connection comes back, to
 * recover events missed while it was down. Queries with a mounted reader and
 * the loaded session-wide lists are refetched; per-scope caches nobody shows
 * (a closed thread's comments) are only marked stale. Synced rows are
 * replaced underneath pending optimistic writes, which stay on top until
 * their own request settles. Thread recaps are left alone: each one covers
 * a fixed newest message, and refetching it would run a new generation.
 */
export async function resyncDataLayer(layer: DataLayer = getDataLayer()): Promise<void> {
  const { queryClient } = layer;
  const queries = queryClient.getQueryCache().findAll({ predicate: shouldResync });
  log.info('resyncing data layer', { queries: queries.length });
  await queryClient.invalidateQueries({
    refetchType: 'none',
    predicate: (query) => !isThreadRecapQueryKey(query.queryKey),
  });
  await Promise.all(
    queries.map((query) =>
      queryClient
        .refetchQueries({ queryKey: query.queryKey, exact: true, type: 'all' })
        .catch(() => undefined),
    ),
  );
}
