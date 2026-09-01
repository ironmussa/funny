import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

export type BoundVanillaStore<T> = {
  (): T;
  <U>(selector: (state: T) => U): U;
} & StoreApi<T>;

export function bindVanillaStore<T>(store: StoreApi<T>): BoundVanillaStore<T> {
  const useBound = (<U>(selector?: (state: T) => U) =>
    useStore(store, selector as (state: T) => U)) as BoundVanillaStore<T>;
  return Object.assign(useBound, store);
}
