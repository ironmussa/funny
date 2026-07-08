/**
 * Server build script — bundles all source code (including @funny/* workspace packages)
 * into a single dist/index.js file for robust npm publishing.
 *
 * Native/optional modules are marked external and resolved at runtime.
 * The pty-helper.mjs file is copied to dist/ since it runs as a separate Node.js process.
 */

import { cp, rm, mkdir } from 'fs/promises';
import { join } from 'path';

import { getBuildInfo } from '../../scripts/build-info';

const ROOT = import.meta.dir;
const DIST = join(ROOT, 'dist');

// Git-derived build identity, embedded as the __BUILD_INFO__ compile-time
// constant so the published bundle reports its build number in logs even when
// .git is absent at runtime (e.g. installed from an npm tarball).
const BUILD_INFO = getBuildInfo();

// Clean previous build
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

// Bundle server + all @funny/* workspace packages into a single file
const result = await Bun.build({
  entrypoints: [join(ROOT, 'src/index.ts')],
  outdir: DIST,
  target: 'bun',
  define: {
    __BUILD_INFO__: JSON.stringify(BUILD_INFO),
  },
  // Bun.build() bundles by default — all workspace packages (@funny/shared,
  // @funny/core) and npm deps (hono, drizzle-orm, etc.) are inlined.
  external: [
    // Native binary — optional, dynamically imported in @funny/core
    'playwright',
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

// Copy pty-daemon.ts to dist/ — pty-daemon-launcher starts it as a separate Bun
// process, so it cannot be bundled into the main runtime entry.
await cp(join(ROOT, 'src', 'services', 'pty-daemon.ts'), join(DIST, 'pty-daemon.ts'));

// Copy deepagent-server.ts to dist/ — it's spawned as a subprocess by DeepAgentProcess
// and resolved via __dirname (which points to dist/ in production)
const coreAgentsDir = join(ROOT, '..', 'core', 'src', 'agents');
await cp(join(coreAgentsDir, 'deepagent-server.ts'), join(DIST, 'deepagent-server.ts'));

// Copy built-in deep agent skills to dist/ — loaded by deepagent-server.ts at runtime
await cp(join(coreAgentsDir, 'deepagent-skills'), join(DIST, 'deepagent-skills'), {
  recursive: true,
});

// Copy built-in pipeline YAMLs to dist/ — read at runtime by yaml-loader.ts
// via `import.meta.url`. After bundling, `import.meta.url` points at
// `dist/index.js`, so the loader expects `dist/defaults/`.
await cp(join(ROOT, '..', 'workflows', 'defaults'), join(DIST, 'defaults'), {
  recursive: true,
});

console.info(`Server build complete! (${BUILD_INFO.label})`);
for (const output of result.outputs) {
  const size = (output.size / 1024).toFixed(1);
  console.info(`  ${output.path} (${size} KB)`);
}
console.info(`  ${join(DIST, 'pty-helper.mjs')} (copied)`);
console.info(`  ${join(DIST, 'pty-daemon.ts')} (copied)`);
console.info(`  ${join(DIST, 'deepagent-server.ts')} (copied)`);
console.info(`  ${join(DIST, 'deepagent-skills/')} (copied)`);
