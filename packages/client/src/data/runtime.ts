import { createClientLogger } from '@/lib/client-logger';

import { createDataLayer, type DataLayer } from './data-layer';

const log = createClientLogger('data-layer');

/**
 * Process-wide holder for the current session's `DataLayer`.
 *
 * `setDataLayerSession` is called synchronously from the auth store
 * subscription (see `lib/data-layer-session.ts`), so the old layer is
 * disposed — aborting its in-flight requests — before any component of
 * the new session renders and starts fetching.
 */

type Listener = () => void;

let current: DataLayer = createDataLayer({ userId: null });
const listeners = new Set<Listener>();

export function getDataLayer(): DataLayer {
  return current;
}

export function subscribeDataLayer(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface DataLayerSession {
  userId: string | null;
  orgId?: string | null;
}

/**
 * Swap to a fresh layer when the session user or active organization
 * changes (server lists are scoped to both). No-op for the same session.
 */
export function setDataLayerSession({ userId, orgId = null }: DataLayerSession): void {
  if (current.userId === userId && current.orgId === orgId) return;
  replaceDataLayer(createDataLayer({ userId, orgId }));
}

/** Install a specific layer (tests, or a forced reset). Disposes the previous one. */
export function replaceDataLayer(next: DataLayer): void {
  const previous = current;
  current = next;
  previous.dispose();
  log.info('data layer swapped', { hasUser: next.userId !== null, hasOrg: next.orgId !== null });
  for (const listener of listeners) listener();
}
