import type { DockviewApi } from 'dockview-react';
import { useCallback, useEffect, useRef } from 'react';

import { LAYOUT_PERSIST_DEBOUNCE_MS, writeStoredLayout } from './layout-storage';

/** Debounced layout persister — `onDidLayoutChange` fires on every pixel of
 *  a splitter drag. Clears the pending write on unmount. */
export function useDebouncedLayoutPersist(storageKey: string) {
  const persistLayoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePersistLayout = useCallback(
    (api: DockviewApi) => {
      if (persistLayoutTimeoutRef.current) clearTimeout(persistLayoutTimeoutRef.current);
      persistLayoutTimeoutRef.current = setTimeout(() => {
        try {
          writeStoredLayout(storageKey, api.toJSON());
        } catch {
          /* defensive — toJSON should never throw, but don't crash the app */
        }
      }, LAYOUT_PERSIST_DEBOUNCE_MS);
    },
    [storageKey],
  );

  useEffect(
    () => () => {
      if (persistLayoutTimeoutRef.current) clearTimeout(persistLayoutTimeoutRef.current);
    },
    [],
  );

  return schedulePersistLayout;
}
