export type StoreListener<T> = (state: T, previousState: T) => void;
export type SetState<T> = (
  partial: Partial<T> | T | ((state: T) => Partial<T> | T),
  replace?: boolean,
) => void;

export interface StoreApi<T> {
  setState: SetState<T>;
  getState(): T;
  getInitialState(): T;
  subscribe(listener: StoreListener<T>): () => void;
}

export type StateCreator<T> = (set: SetState<T>, get: () => T) => T;

export function createStore<T>(createState: StateCreator<T>): StoreApi<T> {
  const listeners = new Set<StoreListener<T>>();
  let state: T;
  const setState: SetState<T> = (partial, replace) => {
    const previousState = state;
    const next =
      typeof partial === 'function' ? (partial as (current: T) => Partial<T> | T)(state) : partial;
    state = replace ? (next as T) : Object.assign({}, state, next);
    if (Object.is(state, previousState)) return;
    for (const listener of listeners) listener(state, previousState);
  };
  const getState = (): T => state;
  state = createState(setState, getState);
  const initialState = state;
  return {
    setState,
    getState,
    getInitialState: () => initialState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
