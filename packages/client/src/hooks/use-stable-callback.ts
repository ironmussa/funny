import { useCallback, useLayoutEffect, useRef } from 'react';

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
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStableCallback<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  }, [fn]);

  // The callback is created once; the ref is only read when it is invoked.
  const stable = useCallback((...args: Parameters<T>) => ref.current(...args), []);
  return stable as T;
}
