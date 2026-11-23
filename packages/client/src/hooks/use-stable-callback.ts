import { useCallback, useInsertionEffect, useRef } from 'react';

/**
 * Returns a referentially-stable callback that always invokes the latest
 * version of `fn`.
 *
 * Use this when you need a callback identity that never changes (e.g. to
 * avoid breaking `memo()`) but you still want access to the latest props
 * and state inside the function body.
 *
 * ```ts
 * const onClick = useStableCallback((id: string) => {
 *   navigate(`/items/${id}`);
 * });
 * // `onClick` identity is stable across re-renders
 * ```
 *
 * Also use it where `useEffectEvent` would fit (an effect that fires on one
 * value but reads the latest of others), listing the result as a dependency.
 * React 19.2.7 does not update an effect event inside a `memo()` or
 * `forwardRef` component, so the event there reads the previous render.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStableCallback<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  // An insertion effect runs before every layout effect of the commit, so a
  // child's layout effect that calls the callback also gets the latest `fn`.
  useInsertionEffect(() => {
    ref.current = fn;
  }, [fn]);

  // The callback is created once; the ref is only read when it is invoked.
  const stable = useCallback((...args: Parameters<T>) => ref.current(...args), []);
  return stable as T;
}
