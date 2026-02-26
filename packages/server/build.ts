/**
 * Server build script — bundles all source code (including @funny/* workspace packages)
 * into a single dist/index.js file for robust npm publishing.
 *
 * Native/optional modules are marked external and resolved at runtime.
 * The pty-helper.mjs file is copied to dist/ since it runs as a separate Node.js process.
 */

import { cp, rm, mkdir } from 'fs/promises';
import { join } from 'path';

const ROOT = import.meta.dir;
const DIST = join(ROOT, 'dist');

// Clean previous build
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

// Bundle server + all @funny/* workspace packages into a single file
const result = await Bun.build({
  entrypoints: [join(ROOT, 'src/index.ts')],
  outdir: DIST,
  target: 'bun',
  // Bun.build() bundles by default — all workspace packages (@funny/shared,
  // @funny/core) and npm deps (hono, drizzle-orm, etc.) are inlined.
  external: [
    // Native binary — optional, dynamically imported in @funny/core
    'playwright',
    // Optional provider — dynamically imported in provider-detection.ts
    '@openai/codex-sdk',
    // node-pty is NOT imported by the server bundle directly.
    // It's only used in pty-helper.mjs which runs under Node.js.
    // Listed here just in case any transitive import pulls it in.
    'node-pty',
  ],
  minify: false, // Keep readable for debugging production issues
  sourcemap: 'external', // Generate .js.map alongside the bundle
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Copy pty-helper.mjs to dist/ — it's spawned as a separate Node.js child process
// and references import.meta.dir at runtime (which resolves to dist/)
await cp(join(ROOT, 'src', 'services', 'pty-helper.mjs'), join(DIST, 'pty-helper.mjs'));

console.log('Server build complete!');
for (const output of result.outputs) {
  const size = (output.size / 1024).toFixed(1);
  console.log(`  ${output.path} (${size} KB)`);
}
console.log(`  ${join(DIST, 'pty-helper.mjs')} (copied)`);
