// Backward-compatible import-map shim for visualizers compiled against
// `@funny/host`. New plugins should import from `@funny/plugin-sdk`.
export { useFunnyFontSize, useFunnyTheme } from './funny-plugin-sdk.mjs';
