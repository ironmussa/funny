/**
 * esbuild script for the Chrome extension.
 *
 * Bundles all TypeScript entry points into self-contained JS files
 * that Chrome can load directly. Output goes to the package root
 * so manifest.json references work without path changes.
 *
 * - background.ts + popup.ts → ESM (service worker and popup page support it)
 * - content.ts + page-bridge.ts → IIFE (content scripts can't use ESM)
 */

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const shared: esbuild.BuildOptions = {
  bundle: true,
  target: 'chrome120',
  minify: false,
  sourcemap: false,
};

if (watch) {
  const [ctx1, ctx2] = await Promise.all([
    esbuild.context({
      ...shared,
      entryPoints: ['src/background.ts', 'src/popup.ts'],
      outdir: '.',
      format: 'esm',
    }),
    esbuild.context({
      ...shared,
      entryPoints: ['src/content.ts', 'src/page-bridge.ts'],
      outdir: '.',
      format: 'iife',
    }),
  ]);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
  console.log('Watching for changes...');
} else {
  await Promise.all([
    esbuild.build({
      ...shared,
      entryPoints: ['src/background.ts', 'src/popup.ts'],
      outdir: '.',
      format: 'esm',
    }),
    esbuild.build({
      ...shared,
      entryPoints: ['src/content.ts', 'src/page-bridge.ts'],
      outdir: '.',
      format: 'iife',
    }),
  ]);
  console.log('Build complete.');
}
