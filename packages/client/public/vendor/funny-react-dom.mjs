// Import-map shim for `react-dom`. Re-exports the funny host's single ReactDOM
// instance (installed at boot on `globalThis.__FUNNY_REACT_DOM__`) so visualizer
// plugins that pull in react-dom (e.g. React Flow uses portals) share the host's
// ReactDOM instead of bundling a second copy.
const RD = globalThis.__FUNNY_REACT_DOM__;
if (!RD) {
  throw new Error(
    '[funny] react-dom host global missing — a visualizer was imported before the host runtime was installed.',
  );
}
export default RD;
export const {
  createPortal,
  flushSync,
  render,
  hydrate,
  unmountComponentAtNode,
  findDOMNode,
  unstable_batchedUpdates,
  version,
} = RD;
