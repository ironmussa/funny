/**
 * Runner build script — bundles the runner into dist/index.js.
 */

import { rm, mkdir } from 'fs/promises';
import { join } from 'path';

const ROOT = import.meta.dir;
const DIST = join(ROOT, 'dist');

// Clean previous build
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(ROOT, 'src/index.ts')],
  outdir: DIST,
  target: 'bun',
  external: ['playwright', '@openai/codex-sdk', 'node-pty'],
  minify: false,
  sourcemap: 'external',
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.info('Runner build complete!');
for (const output of result.outputs) {
  const size = (output.size / 1024).toFixed(1);
  console.info(`  ${output.path} (${size} KB)`);
}
