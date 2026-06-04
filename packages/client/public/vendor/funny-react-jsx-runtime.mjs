// Import-map shim for `react/jsx-runtime` (the JSX automatic runtime used by
// plugins built with `jsx: 'react-jsx'`). Re-exports the host's instance.
const R = globalThis.__FUNNY_REACT_JSX_RUNTIME__;
if (!R) {
  throw new Error(
    '[funny] react/jsx-runtime host global missing — a visualizer was imported before the host runtime was installed.',
  );
}
export const { Fragment, jsx, jsxs } = R;
