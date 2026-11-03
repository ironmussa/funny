import { useSyncExternalStore } from 'react';

import type { DataLayer } from './data-layer';
import { getDataLayer, subscribeDataLayer } from './runtime';

/** The current session's data layer. Re-renders when the session swaps it. */
export function useDataLayer(): DataLayer {
  return useSyncExternalStore(subscribeDataLayer, getDataLayer, getDataLayer);
}
