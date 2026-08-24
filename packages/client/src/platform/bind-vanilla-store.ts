import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

export type BoundVanillaStore<T> = {
  (): T;
  <U>(selector: (state: T) => U): U;
} & StoreApi<T>;

export function bindVanillaStore<T>(store: StoreApi<T>): BoundVanillaStore<T> {
  const useBound = (<U>(selector?: (state: T) => U) => {
    if (selector) return useStore(store, selector);
    return useStore(store);
  }) as BoundVanillaStore<T>;
  return Object.assign(useBound, store);
}
