// Build the plugin to a single ESM bundle.
//
// react / react-dom / react/jsx-runtime stay EXTERNAL (the funny host provides
// the single instances via its import map — never bundle a second React/ReactDOM).
//
// Some bundled deps (use-sync-external-store, react-dom's CJS entry) are CommonJS
// and call `require("react")` / `require("react-dom")`. esbuild turns those into
// a `__require(...)` that throws in the browser ("Dynamic require of X is not
// supported"). The banner defines a `require()` that resolves those two from the
// (external, import-mapped) host modules, so the CJS shims work against the
// host's React.
import { build } from 'esbuild';

const requireShim = [
  'import * as __funnyReact from "react";',
  'import * as __funnyReactDom from "react-dom";',
  'const require = (m) => {',
  '  if (m === "react") return __funnyReact.default || __funnyReact;',
  '  if (m === "react-dom") return __funnyReactDom.default || __funnyReactDom;',
  '  throw new Error("[funny-visualizer-dbml] unexpected require: " + m);',
  '};',
].join('\n');

await build({
  entryPoints: ['src/index.tsx'],
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  banner: { js: requireShim },
  outfile: 'dist/index.mjs',
  logLevel: 'info',
});
