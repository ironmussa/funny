import {
  hashKey,
  QueriesObserver,
  QueryObserver,
  type QueryClient,
  type QueryFunction,
  type QueryKey,
  type QueryObserverResult,
} from '@tanstack/query-core';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type { DataLayer } from './data-layer';
import { getDataLayer, subscribeDataLayer } from './runtime';

/** The current session's data layer. Re-renders when the session swaps it. */
export function useDataLayer(): DataLayer {
  return useSyncExternalStore(subscribeDataLayer, getDataLayer, getDataLayer);
}

export interface DataQueryOptions<T> {
  queryKey: QueryKey;
  queryFn: QueryFunction<T>;
  staleTime?: number;
  enabled?: boolean;
}

/** One observer per query client and key, shared by every component reading that key. */
const observers = new WeakMap<QueryClient, Map<string, QueryObserver<unknown>>>();

function observerFor<T>(client: QueryClient, options: DataQueryOptions<T>): QueryObserver<T> {
  let byKey = observers.get(client);
  if (!byKey) {
    byKey = new Map();
    observers.set(client, byKey);
  }
  const keyHash = hashKey(options.queryKey);
  let observer = byKey.get(keyHash) as QueryObserver<T> | undefined;
  if (!observer) {
    observer = new QueryObserver(client, options);
    byKey.set(keyHash, observer as QueryObserver<unknown>);
  }
  return observer;
}

/**
 * Subscribe to a query on the session's `QueryClient`, for request-shaped data
 * that is not an entity collection (aggregates, stats). Fetches on first
 * subscribe when stale; every component using the same key shares the result.
 */
export function useDataQuery<T>(options: DataQueryOptions<T>): QueryObserverResult<T> {
  const observer = observerFor(useDataLayer().queryClient, options);
  useEffect(() => {
    observer.setOptions(options);
  });
  const subscribe = useCallback((onChange: () => void) => observer.subscribe(onChange), [observer]);
  const current = useCallback(() => observer.getCurrentResult(), [observer]);
  return useSyncExternalStore(subscribe, current, current);
}

const queriesObservers = new WeakMap<QueryClient, Map<string, QueriesObserver>>();

/**
 * `useDataQuery` for a fixed list of keys (one query per item), so each key
 * keeps its own freshness and a slow request does not hold up the others.
 */
export function useDataQueries<T>(
  queries: readonly DataQueryOptions<T>[],
): readonly QueryObserverResult<T>[] {
  const client = useDataLayer().queryClient;
  let byKey = queriesObservers.get(client);
  if (!byKey) {
    byKey = new Map();
    queriesObservers.set(client, byKey);
  }
  const keyHash = hashKey(queries.map((q) => q.queryKey));
  let observer = byKey.get(keyHash);
  if (!observer) {
    observer = new QueriesObserver(client, [...queries]);
    byKey.set(keyHash, observer);
  }
  const shared = observer;
  useEffect(() => {
    shared.setQueries([...queries]);
  });
  const subscribe = useCallback((onChange: () => void) => shared.subscribe(onChange), [shared]);
  const current = useCallback(() => shared.getCurrentResult(), [shared]);
  return useSyncExternalStore(subscribe, current, current) as QueryObserverResult<T>[];
}
