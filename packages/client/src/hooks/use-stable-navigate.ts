import { useCallback, useLayoutEffect, useRef } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';

/**
 * Returns a referentially-stable navigate function.
 *
 * React Router's `useNavigate()` may return a new function on every route
 * change, which invalidates any `useCallback` that lists it as a dependency.
 * This hook stores the latest navigate in a ref and returns a wrapper that
 * never changes identity, so downstream callbacks stay stable.
 */
export function useStableNavigate(): NavigateFunction {
  const navigate = useNavigate();
  const ref = useRef(navigate);
  useLayoutEffect(() => {
    ref.current = navigate;
  }, [navigate]);

  // Stable wrapper — same identity for the lifetime of the component.
  const stable = useCallback((...args: Parameters<NavigateFunction>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (ref.current as any)(...args);
  }, []) as NavigateFunction;

  return stable;
}
