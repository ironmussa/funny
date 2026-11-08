import { getSourceObjectToken, type LiveQueryKey } from '@tanstack/db';

/**
 * Explicit `queryKey` for `useLiveQuery`. Without one, the hook rebuilds and
 * hashes the query IR on every render, which shows up as a hot render path in
 * lists that render many rows.
 *
 * The key names the collection by object token, not by Collection ID: a new
 * DataLayer for the same user reuses the ID, and a key built from the ID would
 * keep the previous layer's live query.
 *
 * Every value the query closure reads must be in `params`: while the key is
 * unchanged the query is not re-evaluated.
 */
export function liveQueryKey(
  name: string,
  collection: object,
  ...params: readonly unknown[]
): LiveQueryKey {
  return [name, getSourceObjectToken(collection), ...params];
}
