// Import-map shim for `react`. Re-exports the funny host's single React
// instance (installed at boot on `globalThis.__FUNNY_REACT__`) so visualizer
// plugins share the host's React and never trigger "Invalid hook call".
const R = globalThis.__FUNNY_REACT__;
if (!R) {
  throw new Error(
    '[funny] React host global missing — a visualizer was imported before the host runtime was installed.',
  );
}
export default R;
export const {
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = R;
