// Import-map shim for `@funny/host`. Re-exports the host SDK surface the host
// installs at boot on `globalThis.__FUNNY_HOST__`. Keep these named exports in
// sync with the public surface of `packages/host/src/index.ts`.
const H = globalThis.__FUNNY_HOST__;
if (!H) {
  throw new Error(
    '[funny] @funny/host global missing — a visualizer was imported before the host runtime was installed.',
  );
}
export const { useFunnyTheme, useFunnyFontSize } = H;
