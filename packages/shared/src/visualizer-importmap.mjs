// ─── Visualizer import map ───────────────────────────────
//
// Single source of truth for the import map that lets dynamically-loaded
// visualizer plugins (ESM, full-trust) resolve the bare specifiers `react`,
// `react/jsx-runtime`, and `@funny/host` to the *host's own* module instances
// — so a plugin never bundles a second copy of React (which would break hooks
// with "Invalid hook call").
//
// The mapped URLs point at tiny shim modules served from the client's
// `public/vendor/` directory; each shim re-exports from a `globalThis.__FUNNY_*`
// value the host installs at boot (see `visualizers/host-runtime.ts`).
//
// Consumed in two places that MUST stay byte-identical:
//   1. The client Vite build injects `<script type="importmap">${JSON}</script>`.
//   2. The server adds `sha256(JSON)` to its CSP `script-src` so the inline
//      import map is allowed under the strict (`'self'`-only) script policy.
//
// Authored as plain ESM (not .ts) so it can be imported directly by the Vite
// config loader (Node ESM), the Bun-run server, and the bundled client alike.
// Types live in the sibling `visualizer-importmap.d.ts`.

export const VISUALIZER_IMPORT_MAP = {
  imports: {
    react: '/vendor/funny-react.mjs',
    'react/jsx-runtime': '/vendor/funny-react-jsx-runtime.mjs',
    'react-dom': '/vendor/funny-react-dom.mjs',
    '@funny/host': '/vendor/funny-host.mjs',
  },
};

export const VISUALIZER_IMPORT_MAP_JSON = JSON.stringify(VISUALIZER_IMPORT_MAP);
