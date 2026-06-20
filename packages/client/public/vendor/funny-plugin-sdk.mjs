// Import-map shim for `@funny/plugin-sdk`. Re-exports the SDK surface the host
// installs at boot on `globalThis.__FUNNY_PLUGIN_SDK__`. Keep these named
// exports in sync with the public surface of `packages/plugin-sdk/src/index.ts`.
const sdk = globalThis.__FUNNY_PLUGIN_SDK__ ?? globalThis.__FUNNY_HOST__;
if (!sdk) {
  throw new Error(
    '[funny] @funny/plugin-sdk global missing — a visualizer was imported before the host runtime was installed.',
  );
}
export const { useFunnyTheme, useFunnyFontSize } = sdk;
