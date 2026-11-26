/** Store and theme hooks shared by the native app components. */

import type { StoreApi } from '@funny/client-core';
import { Button } from '@funny/gpuix-ui/button';
import { useGpuixUiTheme } from '@funny/gpuix-ui/theme';
import { useCallback, useSyncExternalStore } from 'react';

import type { NativeApplicationServices } from '../application';

export function useStore<T>(store: StoreApi<T>): T {
  return useSyncExternalStore(
    useCallback((notify) => store.subscribe(() => notify()), [store]),
    store.getState,
    store.getInitialState,
  );
}

export function useNativeColors() {
  return useGpuixUiTheme().colors;
}

export function useStoreValue<T, U>(store: StoreApi<T>, selector: (state: T) => U): U {
  return useSyncExternalStore(
    useCallback((notify) => store.subscribe(() => notify()), [store]),
    useCallback(() => selector(store.getState()), [selector, store]),
    useCallback(() => selector(store.getInitialState()), [selector, store]),
  );
}

export const selectSelectedThreadId = (state: { selectedThreadId: string | null }) =>
  state.selectedThreadId;

export const NativeButton = Button;

export function useRealtimeState(application: NativeApplicationServices) {
  return useSyncExternalStore(
    useCallback((notify) => application.realtime.subscribe(() => notify()), [application]),
    () => application.realtime.current(),
    () => application.realtime.current(),
  );
}
