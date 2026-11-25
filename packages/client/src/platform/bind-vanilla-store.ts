import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

export type BoundVanillaStore<T> = {
  (): T;
  <U>(selector: (state: T) => U): U;
} & StoreApi<T>;

export function bindVanillaStore<T>(store: StoreApi<T>): BoundVanillaStore<T> {
  // SAFETY: useStore treats a missing selector as the identity, so calling it with
  // `undefined` returns T, which is the no-argument overload of BoundVanillaStore;
  // the store's own fields are added by Object.assign below.
  const useBound = (<U>(selector?: (state: T) => U) =>
    useStore(store, selector as (state: T) => U)) as BoundVanillaStore<T>;
  return Object.assign(useBound, store);
}
