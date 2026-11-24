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

/** A store's state is a plain object, so a function passed to `setState` is an updater. */
function isUpdater<T>(
  partial: Partial<T> | T | ((state: T) => Partial<T> | T),
): partial is (state: T) => Partial<T> | T {
  return typeof partial === 'function';
}

export function createStore<T>(createState: StateCreator<T>): StoreApi<T> {
  const listeners = new Set<StoreListener<T>>();
  let state: T;
  const setState: SetState<T> = (partial, replace) => {
    const previousState = state;
    const next = isUpdater(partial) ? partial(state) : partial;
    // SAFETY: `replace: true` is the caller's promise (as in zustand) that `next` is a whole
    // state, not a partial one.
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
